/**
 * The MCP server: the tool list and every tool call, built from a Gmail client and the
 * scopes the saved credentials grant. index.ts loads the credentials and connects it to
 * stdio; tests connect it to an in-memory transport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { needsRawBuilder } from "./utl.js";
import { createDraft, encodeMessage, messageRequest, resolveThreadingHeaders, type ComposeArgs } from "./compose.js";
import { createLabel, updateLabel, deleteLabel, listLabels, findLabelByName, getOrCreateLabel, GmailLabel } from "./label-manager.js";
import { createFilter, listFilters, getFilter, deleteFilter, filterTemplates, GmailFilterCriteria, GmailFilterAction } from "./filter-manager.js";
import { parseEmailAddresses, filterOutEmail, addRePrefix, buildReferencesHeader, buildReplyAllRecipients } from "./reply-all-helpers.js";
import { hasScope } from "./scopes.js";
import { toolDefinitions, toMcpTools, getToolByName, SendEmailSchema, ReadEmailSchema, SearchEmailsSchema, ModifyEmailSchema, DeleteEmailSchema, BatchModifyEmailsSchema, ReportPhishingSchema, BatchReportPhishingSchema, BatchDeleteEmailsSchema, CreateLabelSchema, UpdateLabelSchema, DeleteLabelSchema, GetOrCreateLabelSchema, CreateFilterSchema, GetFilterSchema, DeleteFilterSchema, CreateFilterFromTemplateSchema, DownloadAttachmentSchema, ReplyAllSchema, GetThreadSchema, ListInboxThreadsSchema, GetInboxWithThreadsSchema, DownloadEmailSchema, ModifyThreadSchema, SendDraftSchema, DeleteDraftSchema, UpdateDraftSchema } from "./tools.js";
import { BatchGetGmailIndexMetadataSchema, GetAttachmentTextSchema, GetGmailProfileSchema, ListGmailAddedHistorySchema, ListGmailMessageIdsSchema } from "./tools.js";
import { getAttachmentText } from "./attachment-text/attachment-text.js";
import { getGmailProfile, listGmailAddedHistory, listGmailMessageIds, structuredResult } from "./gmail-sync.js";
import { batchGetGmailIndexMetadata } from "./gmail-batch.js";
import { handleBatchFetchWindow } from "./batch-fetch-window.js";
import { failureDetail, scopeRefusal, toolErrorResult } from "./error-text.js";
import { searchEmails, formatSearchEmailsText, readEmail, formatReadEmailText, downloadAttachment, formatDownloadAttachmentText, downloadEmail, getInboxWithThreads, getThread, listInboxThreads } from "./read-tools.js";

export interface GmailServerDeps {
    gmail: gmail_v1.Gmail;
    // Used by batch_get_gmail_index_metadata, which sends a raw batch request.
    oauth2Client: OAuth2Client;
    // The scopes the saved credentials grant; tools outside them are hidden and refused.
    authorizedScopes: string[];
    // Optional tool-name prefix, see tool-prefix.ts.
    toolPrefix: string;
}

export function createGmailServer(deps: GmailServerDeps): Server {
    const { gmail, oauth2Client, authorizedScopes, toolPrefix: TOOL_PREFIX } = deps;

    // Server implementation
    const server = new Server(
        {
            name: "gmail",
            version: "1.3.0",
        },
        {
            capabilities: {
                tools: {},
            },
        },
    );

    // Tool handlers
    // Filter available tools based on authorized scopes
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const availableTools = toolDefinitions.filter(tool =>
            hasScope(authorizedScopes, tool.scopes)
        );
        const mcpTools = toMcpTools(availableTools);
        // Apply optional TOOL_PREFIX so multiple server instances can coexist
        // in clients that dedupe tool entries by base name.
        return { tools: mcpTools.map(t => ({ ...t, name: TOOL_PREFIX + t.name })) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name: rawName, arguments: args } = request.params;

        // Strip TOOL_PREFIX only if the result is a known base tool name.
        // Guards against accidental over-stripping when the prefix overlaps a tool name's start
        // (e.g. prefix="send_" + rawName="send_email" → "email", which is not a tool).
        const stripped = TOOL_PREFIX && rawName.startsWith(TOOL_PREFIX)
            ? rawName.slice(TOOL_PREFIX.length)
            : rawName;
        const name = getToolByName(stripped) ? stripped : rawName;

        // Verify the tool is authorized for the current scopes
        // This guards against direct tool calls that bypass ListTools
        const toolDef = getToolByName(name);
        if (!toolDef || !hasScope(authorizedScopes, toolDef.scopes)) {
            return toolErrorResult(name, new Error(scopeRefusal(name)));
        }

        // Every call's arguments are checked against the tool's own strict schema before its
        // handler runs, so an unknown argument is refused even by a tool that reads none.
        const checked = toolDef.schema.safeParse(args ?? {});
        if (!checked.success) {
            return toolErrorResult(name, checked.error);
        }

        async function handleEmailAction(action: "send" | "draft", validatedArgs: ComposeArgs) {
            try {
                if (action === "draft") {
                    const draftId = await createDraft(gmail, validatedArgs);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email draft created successfully with ID: ${draftId}`,
                            },
                        ],
                    };
                }
                await resolveThreadingHeaders(gmail, validatedArgs);
                const raw = await encodeMessage(validatedArgs);
                const result = await gmail.users.messages.send({
                    userId: 'me',
                    requestBody: messageRequest(raw, validatedArgs),
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: `Email sent successfully with ID: ${result.data.id}`,
                        },
                    ],
                };
            } catch (error: any) {
                // Log attachment / inline-image errors for debugging
                if (needsRawBuilder(validatedArgs)) {
                    const nAtt = validatedArgs.attachments?.length || 0;
                    const nImg = validatedArgs.inlineImages?.length || 0;
                    console.error(`Failed to send email with ${nAtt} attachment(s) and ${nImg} inline image(s):`, error.message);
                }
                throw error;
            }
        }

        // Helper function to process operations in batches
        async function processBatches<T, U>(
            items: T[],
            batchSize: number,
            processFn: (batch: T[]) => Promise<U[]>
        ): Promise<{ successes: U[], failures: { item: T, error: Error }[] }> {
            const successes: U[] = [];
            const failures: { item: T, error: Error }[] = [];
            
            // Process in batches
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                try {
                    const results = await processFn(batch);
                    successes.push(...results);
                } catch (error) {
                    // If batch fails, try individual items
                    for (const item of batch) {
                        try {
                            const result = await processFn([item]);
                            successes.push(...result);
                        } catch (itemError) {
                            failures.push({ item, error: itemError as Error });
                        }
                    }
                }
            }
            
            return { successes, failures };
        }

        try {
            switch (name) {
                case "get_gmail_profile": {
                    GetGmailProfileSchema.parse(args ?? {});
                    return structuredResult({ ...await getGmailProfile(gmail) });
                }

                case "list_gmail_message_ids": {
                    const validatedArgs = ListGmailMessageIdsSchema.parse(args ?? {});
                    return structuredResult({ ...await listGmailMessageIds(gmail, validatedArgs) });
                }

                case "list_gmail_added_history": {
                    const validatedArgs = ListGmailAddedHistorySchema.parse(args);
                    return structuredResult({ ...await listGmailAddedHistory(gmail, validatedArgs) });
                }

                case "batch_get_gmail_index_metadata": {
                    const validatedArgs = BatchGetGmailIndexMetadataSchema.parse(args);
                    return structuredResult({
                        ...await batchGetGmailIndexMetadata(oauth2Client, validatedArgs.messageIds),
                    });
                }

                case "batch_fetch_window": {
                    return await handleBatchFetchWindow(gmail, args);
                }

                case "send_email":
                case "draft_email": {
                    const validatedArgs = SendEmailSchema.parse(args);
                    const action = name === "send_email" ? "send" : "draft";
                    return await handleEmailAction(action, validatedArgs);
                }

                case "read_email": {
                    const validatedArgs = ReadEmailSchema.parse(args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatReadEmailText(await readEmail(gmail, validatedArgs)),
                            },
                        ],
                    };
                }

                case "search_emails": {
                    const validatedArgs = SearchEmailsSchema.parse(args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatSearchEmailsText(await searchEmails(gmail, validatedArgs)),
                            },
                        ],
                    };
                }

                case "download_email": {
                    const validatedArgs = DownloadEmailSchema.parse(args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(await downloadEmail(gmail, validatedArgs), null, 2),
                            },
                        ],
                    };
                }

                case "modify_email": {
                    const validatedArgs = ModifyEmailSchema.parse(args);
                    
                    // Prepare request body
                    const requestBody: any = {};
                    
                    if (validatedArgs.labelIds) {
                        requestBody.addLabelIds = validatedArgs.labelIds;
                    }
                    
                    if (validatedArgs.addLabelIds) {
                        requestBody.addLabelIds = validatedArgs.addLabelIds;
                    }
                    
                    if (validatedArgs.removeLabelIds) {
                        requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }
                    
                    await gmail.users.messages.modify({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        requestBody: requestBody,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} labels updated successfully`,
                            },
                        ],
                    };
                }

                case "delete_email": {
                    const validatedArgs = DeleteEmailSchema.parse(args);
                    await gmail.users.messages.delete({
                        userId: 'me',
                        id: validatedArgs.messageId,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} deleted successfully`,
                            },
                        ],
                    };
                }

                case "send_draft": {
                    const validatedArgs = SendDraftSchema.parse(args);
                    const response = await gmail.users.drafts.send({
                        userId: 'me',
                        requestBody: { id: validatedArgs.draftId },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Draft ${validatedArgs.draftId} sent successfully as message ID: ${response.data.id}. The draft has been removed from Drafts.`,
                            },
                        ],
                    };
                }

                case "delete_draft": {
                    const validatedArgs = DeleteDraftSchema.parse(args);
                    await gmail.users.drafts.delete({
                        userId: 'me',
                        id: validatedArgs.draftId,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Draft ${validatedArgs.draftId} deleted successfully.`,
                            },
                        ],
                    };
                }

                case "update_draft": {
                    const validatedArgs = UpdateDraftSchema.parse(args);
                    const { draftId, ...messageArgs } = validatedArgs;

                    // Build the new MIME message with the same code as draft_email/send_email
                    const encodedMessage = await encodeMessage(messageArgs);
                    await gmail.users.drafts.update({
                        userId: 'me',
                        id: draftId,
                        requestBody: { message: messageRequest(encodedMessage, messageArgs) },
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Draft ${draftId} updated successfully (draft ID unchanged, content replaced).`,
                            },
                        ],
                    };
                }

                case "list_email_labels": {
                    const labelResults = await listLabels(gmail);
                    const systemLabels = labelResults.system;
                    const userLabels = labelResults.user;

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
                                    "System Labels:\n" +
                                    systemLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n') +
                                    "\nUser Labels:\n" +
                                    userLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n')
                            },
                        ],
                    };
                }

                case "batch_modify_emails": {
                    const validatedArgs = BatchModifyEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;
                    
                    // Prepare request body
                    const requestBody: any = {};
                    
                    if (validatedArgs.addLabelIds) {
                        requestBody.addLabelIds = validatedArgs.addLabelIds;
                    }
                    
                    if (validatedArgs.removeLabelIds) {
                        requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }

                    // Process messages in batches
                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            const results = await Promise.all(
                                batch.map(async (messageId) => {
                                    const result = await gmail.users.messages.modify({
                                        userId: 'me',
                                        id: messageId,
                                        requestBody: requestBody,
                                    });
                                    return { messageId, success: true };
                                })
                            );
                            return results;
                        }
                    );

                    // Generate summary of the operation
                    const successCount = successes.length;
                    const failureCount = failures.length;
                    
                    let resultText = `Batch label modification complete.\n`;
                    resultText += `Successfully processed: ${successCount} messages\n`;
                    
                    if (failureCount > 0) {
                        resultText += `Failed to process: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${f.item}: ${failureDetail(f.error)}`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                case "report_phishing": {
                    const validatedArgs = ReportPhishingSchema.parse(args);

                    await gmail.users.messages.modify({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        requestBody: {
                            addLabelIds: ['SPAM'],
                        },
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} was updated with the SPAM label as the closest public Gmail API approximation of reporting phishing. Note: the Gmail API does not expose the full native Report phishing workflow.`,
                            },
                        ],
                    };
                }

                case "batch_report_phishing": {
                    const validatedArgs = BatchReportPhishingSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;

                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            await gmail.users.messages.batchModify({
                                userId: 'me',
                                requestBody: {
                                    ids: batch,
                                    addLabelIds: ['SPAM'],
                                },
                            });

                            return batch.map((messageId) => ({ messageId, success: true }));
                        }
                    );

                    const successCount = successes.length;
                    const failureCount = failures.length;

                    let resultText = `Batch phishing report complete.\n`;
                    resultText += `Successfully processed: ${successCount} messages\n`;
                    resultText += `Behavior: each message was updated with the SPAM label as the closest public Gmail API approximation of reporting phishing.\n`;
                    resultText += `Limitation: the Gmail API does not expose the full native Report phishing workflow.\n`;

                    if (failureCount > 0) {
                        resultText += `Failed to process: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${f.item}: ${failureDetail(f.error)}`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                case "batch_delete_emails": {
                    const validatedArgs = BatchDeleteEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;

                    // Process messages in batches
                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            const results = await Promise.all(
                                batch.map(async (messageId) => {
                                    await gmail.users.messages.delete({
                                        userId: 'me',
                                        id: messageId,
                                    });
                                    return { messageId, success: true };
                                })
                            );
                            return results;
                        }
                    );

                    // Generate summary of the operation
                    const successCount = successes.length;
                    const failureCount = failures.length;
                    
                    let resultText = `Batch delete operation complete.\n`;
                    resultText += `Successfully deleted: ${successCount} messages\n`;
                    
                    if (failureCount > 0) {
                        resultText += `Failed to delete: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${f.item}: ${failureDetail(f.error)}`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                // Label management handlers
                case "create_label": {
                    const validatedArgs = CreateLabelSchema.parse(args);
                    const result = await createLabel(gmail, validatedArgs.name, {
                        messageListVisibility: validatedArgs.messageListVisibility,
                        labelListVisibility: validatedArgs.labelListVisibility,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }

                case "update_label": {
                    const validatedArgs = UpdateLabelSchema.parse(args);
                    
                    // Prepare request body with only the fields that were provided
                    const updates: any = {};
                    if (validatedArgs.name) updates.name = validatedArgs.name;
                    if (validatedArgs.messageListVisibility) updates.messageListVisibility = validatedArgs.messageListVisibility;
                    if (validatedArgs.labelListVisibility) updates.labelListVisibility = validatedArgs.labelListVisibility;
                    
                    const result = await updateLabel(gmail, validatedArgs.id, updates);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }

                case "delete_label": {
                    const validatedArgs = DeleteLabelSchema.parse(args);
                    const result = await deleteLabel(gmail, validatedArgs.id);

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message,
                            },
                        ],
                    };
                }

                case "get_or_create_label": {
                    const validatedArgs = GetOrCreateLabelSchema.parse(args);
                    const result = await getOrCreateLabel(gmail, validatedArgs.name, {
                        messageListVisibility: validatedArgs.messageListVisibility,
                        labelListVisibility: validatedArgs.labelListVisibility,
                    });

                    const action = result.type === 'user' && result.name === validatedArgs.name ? 'found existing' : 'created new';
                    
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }


                // Filter management handlers
                case "create_filter": {
                    const validatedArgs = CreateFilterSchema.parse(args);
                    const result = await createFilter(gmail, validatedArgs.criteria, validatedArgs.action);

                    // Format criteria for display
                    const criteriaText = Object.entries(validatedArgs.criteria)
                        .filter(([_, value]) => value !== undefined)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');

                    // Format actions for display
                    const actionText = Object.entries(validatedArgs.action)
                        .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                            },
                        ],
                    };
                }

                case "list_filters": {
                    const result = await listFilters(gmail);
                    const filters = result.filters;

                    if (filters.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No filters found.",
                                },
                            ],
                        };
                    }

                    const filtersText = filters.map((filter: any) => {
                        const criteriaEntries = Object.entries(filter.criteria || {})
                            .filter(([_, value]) => value !== undefined)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(', ');
                        
                        const actionEntries = Object.entries(filter.action || {})
                            .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                            .join(', ');

                        return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
                    }).join('\n');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${result.count} filters:\n\n${filtersText}`,
                            },
                        ],
                    };
                }

                case "get_filter": {
                    const validatedArgs = GetFilterSchema.parse(args);
                    const result = await getFilter(gmail, validatedArgs.filterId);

                    const criteriaText = Object.entries(result.criteria || {})
                        .filter(([_, value]) => value !== undefined)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');
                    
                    const actionText = Object.entries(result.action || {})
                        .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                            },
                        ],
                    };
                }

                case "delete_filter": {
                    const validatedArgs = DeleteFilterSchema.parse(args);
                    const result = await deleteFilter(gmail, validatedArgs.filterId);

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message,
                            },
                        ],
                    };
                }

                case "create_filter_from_template": {
                    const validatedArgs = CreateFilterFromTemplateSchema.parse(args);
                    const template = validatedArgs.template;
                    const params = validatedArgs.parameters;

                    let filterConfig;
                    
                    switch (template) {
                        case 'fromSender':
                            if (!params.senderEmail) throw new Error("senderEmail is required for fromSender template");
                            filterConfig = filterTemplates.fromSender(params.senderEmail, params.labelIds, params.archive);
                            break;
                        case 'withSubject':
                            if (!params.subjectText) throw new Error("subjectText is required for withSubject template");
                            filterConfig = filterTemplates.withSubject(params.subjectText, params.labelIds, params.markAsRead);
                            break;
                        case 'withAttachments':
                            filterConfig = filterTemplates.withAttachments(params.labelIds);
                            break;
                        case 'largeEmails':
                            if (!params.sizeInBytes) throw new Error("sizeInBytes is required for largeEmails template");
                            filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
                            break;
                        case 'containingText':
                            if (!params.searchText) throw new Error("searchText is required for containingText template");
                            filterConfig = filterTemplates.containingText(params.searchText, params.labelIds, params.markImportant);
                            break;
                        case 'mailingList':
                            if (!params.listIdentifier) throw new Error("listIdentifier is required for mailingList template");
                            filterConfig = filterTemplates.mailingList(params.listIdentifier, params.labelIds, params.archive);
                            break;
                        default:
                            throw new Error(`Unknown template: ${template}`);
                    }

                    const result = await createFilter(gmail, filterConfig.criteria, filterConfig.action);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
                            },
                        ],
                    };
                }
                case "download_attachment": {
                    const validatedArgs = DownloadAttachmentSchema.parse(args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatDownloadAttachmentText(await downloadAttachment(gmail, validatedArgs)),
                            },
                        ],
                    };
                }

                case "get_attachment_text": {
                    const validatedArgs = GetAttachmentTextSchema.parse(args);
                    return structuredResult({ ...await getAttachmentText(gmail, validatedArgs) });
                }

                case "get_thread": {
                    const validatedArgs = GetThreadSchema.parse(args);
                    return { content: [{ type: "text", text: JSON.stringify(await getThread(gmail, validatedArgs), null, 2) }] };
                }

                case "list_inbox_threads": {
                    const validatedArgs = ListInboxThreadsSchema.parse(args);
                    return { content: [{ type: "text", text: JSON.stringify(await listInboxThreads(gmail, validatedArgs), null, 2) }] };
                }

                case "get_inbox_with_threads": {
                    const validatedArgs = GetInboxWithThreadsSchema.parse(args);
                    return { content: [{ type: "text", text: JSON.stringify(await getInboxWithThreads(gmail, validatedArgs), null, 2) }] };
                }

                case "reply_all": {
                    const validatedArgs = ReplyAllSchema.parse(args);

                    // Fetch the original email to get headers
                    const originalEmail = await gmail.users.messages.get({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        format: 'full',
                    });

                    const headers = originalEmail.data.payload?.headers || [];
                    const threadId = originalEmail.data.threadId || '';

                    // Extract relevant headers
                    const originalFrom = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
                    const originalTo = headers.find(h => h.name?.toLowerCase() === 'to')?.value || '';
                    const originalCc = headers.find(h => h.name?.toLowerCase() === 'cc')?.value || '';
                    const originalSubject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
                    const originalMessageId = headers.find(h => h.name?.toLowerCase() === 'message-id')?.value || '';
                    const originalReferences = headers.find(h => h.name?.toLowerCase() === 'references')?.value || '';

                    // Get authenticated user's email to exclude from recipients
                    const profile = await gmail.users.getProfile({ userId: 'me' });
                    const myEmail = profile.data.emailAddress?.toLowerCase() || '';

                    // Build recipient list using helper functions
                    const { to: replyTo, cc: replyCc } = buildReplyAllRecipients(
                        originalFrom,
                        originalTo,
                        originalCc,
                        myEmail
                    );

                    if (replyTo.length === 0) {
                        throw new Error('Could not determine recipient for reply');
                    }

                    // Build subject with "Re:" prefix if not already present
                    const replySubject = addRePrefix(originalSubject);

                    // Build References header (original References + original Message-ID)
                    const references = buildReferencesHeader(originalReferences, originalMessageId);

                    // Prepare the email arguments for handleEmailAction
                    const emailArgs = {
                        to: replyTo,
                        cc: replyCc.length > 0 ? replyCc : undefined,
                        subject: replySubject,
                        body: validatedArgs.body,
                        htmlBody: validatedArgs.htmlBody,
                        mimeType: validatedArgs.mimeType,
                        threadId: threadId,
                        inReplyTo: originalMessageId,
                        attachments: validatedArgs.attachments,
                        inlineImages: validatedArgs.inlineImages,
                    };

                    // Use the existing handleEmailAction to send the reply
                    const result = await handleEmailAction("send", emailArgs);

                    // Enhance the response with reply-all specific info
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Reply-all sent successfully!\nTo: ${replyTo.join(', ')}${replyCc.length > 0 ? `\nCC: ${replyCc.join(', ')}` : ''}\nSubject: ${replySubject}\nThread ID: ${threadId}`,
                            },
                        ],
                    };
                }

                case "modify_thread": {
                    const validatedArgs = ModifyThreadSchema.parse(args);

                    // Prepare request body for threads.modify
                    const modifyRequestBody: any = {};

                    if (validatedArgs.addLabelIds) {
                        modifyRequestBody.addLabelIds = validatedArgs.addLabelIds;
                    }

                    if (validatedArgs.removeLabelIds) {
                        modifyRequestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }

                    await gmail.users.threads.modify({
                        userId: 'me',
                        id: validatedArgs.threadId,
                        requestBody: modifyRequestBody,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ${validatedArgs.threadId} labels updated successfully (all messages in thread modified)`,
                            },
                        ],
                    };
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error) {
            return toolErrorResult(name, error);
        }
    });

    return server;
}
