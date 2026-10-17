/**
 * Filter Manager for Gmail MCP Server
 * Creates, lists, gets and deletes Gmail filters, and builds filters from templates.
 *
 * A Gmail failure is rethrown as it is, or with a message that adds context through
 * withContext, so the caller's error text keeps Gmail's reason, status and rejected
 * parameters.
 */

import { withContext } from './error-text.js';

// Type definitions for Gmail API filters
export interface GmailFilterCriteria {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    negatedQuery?: string;
    hasAttachment?: boolean;
    excludeChats?: boolean;
    size?: number;
    sizeComparison?: 'unspecified' | 'smaller' | 'larger';
}

export interface GmailFilterAction {
    addLabelIds?: string[];
    removeLabelIds?: string[];
    forward?: string;
}

export interface GmailFilter {
    id?: string;
    criteria: GmailFilterCriteria;
    action: GmailFilterAction;
}

/**
 * Creates a new Gmail filter
 * @param gmail - Gmail API instance
 * @param criteria - Filter criteria to match messages
 * @param action - Actions to perform on matching messages
 * @returns The newly created filter
 */
export async function createFilter(gmail: any, criteria: GmailFilterCriteria, action: GmailFilterAction) {
    try {
        const filterBody: GmailFilter = {
            criteria,
            action
        };

        const response = await gmail.users.settings.filters.create({
            userId: 'me',
            requestBody: filterBody,
        });

        return response.data;
    } catch (error: any) {
        if (error.code === 400) {
            throw withContext(`Invalid filter criteria or action: ${error.message}`, error);
        }
        throw error;
    }
}

/**
 * Lists all Gmail filters
 * @param gmail - Gmail API instance
 * @returns Array of all filters
 */
export async function listFilters(gmail: any) {
    const response = await gmail.users.settings.filters.list({
        userId: 'me',
    });

    const filters = response.data.filter || [];

    return {
        filters,
        count: filters.length
    };
}

/**
 * Gets a specific Gmail filter by ID
 * @param gmail - Gmail API instance
 * @param filterId - ID of the filter to retrieve
 * @returns The filter details
 */
export async function getFilter(gmail: any, filterId: string) {
    try {
        const response = await gmail.users.settings.filters.get({
            userId: 'me',
            id: filterId,
        });

        return response.data;
    } catch (error: any) {
        if (error.code === 404) {
            throw withContext(`Filter with ID "${filterId}" not found.`, error);
        }
        throw error;
    }
}

/**
 * Deletes a Gmail filter
 * @param gmail - Gmail API instance
 * @param filterId - ID of the filter to delete
 * @returns Success message
 */
export async function deleteFilter(gmail: any, filterId: string) {
    try {
        await gmail.users.settings.filters.delete({
            userId: 'me',
            id: filterId,
        });

        return { success: true, message: `Filter "${filterId}" deleted successfully.` };
    } catch (error: any) {
        if (error.code === 404) {
            throw withContext(`Filter with ID "${filterId}" not found.`, error);
        }
        throw error;
    }
}

/**
 * Helper function to create common filter patterns
 */
export const filterTemplates = {
    /**
     * Filter emails from a specific sender
     */
    fromSender: (senderEmail: string, labelIds: string[] = [], archive: boolean = false): { criteria: GmailFilterCriteria, action: GmailFilterAction } => ({
        criteria: { from: senderEmail },
        action: {
            addLabelIds: labelIds,
            removeLabelIds: archive ? ['INBOX'] : undefined
        }
    }),

    /**
     * Filter emails with specific subject
     */
    withSubject: (subjectText: string, labelIds: string[] = [], markAsRead: boolean = false): { criteria: GmailFilterCriteria, action: GmailFilterAction } => ({
        criteria: { subject: subjectText },
        action: {
            addLabelIds: labelIds,
            removeLabelIds: markAsRead ? ['UNREAD'] : undefined
        }
    }),

    /**
     * Filter emails with attachments
     */
    withAttachments: (labelIds: string[] = []): { criteria: GmailFilterCriteria, action: GmailFilterAction } => ({
        criteria: { hasAttachment: true },
        action: { addLabelIds: labelIds }
    }),

    /**
     * Filter large emails
     */
    largeEmails: (sizeInBytes: number, labelIds: string[] = []): { criteria: GmailFilterCriteria, action: GmailFilterAction } => ({
        criteria: { size: sizeInBytes, sizeComparison: 'larger' },
        action: { addLabelIds: labelIds }
    }),

    /**
     * Filter emails containing specific text
     */
    containingText: (searchText: string, labelIds: string[] = [], markImportant: boolean = false): { criteria: GmailFilterCriteria, action: GmailFilterAction } => ({
        criteria: { query: `"${searchText}"` },
        action: {
            addLabelIds: markImportant ? [...labelIds, 'IMPORTANT'] : labelIds
        }
    }),

    /**
     * Filter mailing list emails (common patterns)
     */
    mailingList: (listIdentifier: string, labelIds: string[] = [], archive: boolean = true): { criteria: GmailFilterCriteria, action: GmailFilterAction } => ({
        criteria: { query: `list:${listIdentifier} OR subject:[${listIdentifier}]` },
        action: {
            addLabelIds: labelIds,
            removeLabelIds: archive ? ['INBOX'] : undefined
        }
    })
}; 