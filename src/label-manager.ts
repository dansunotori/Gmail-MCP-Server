/**
 * Label Manager for Gmail MCP Server
 * Provides comprehensive label management functionality
 *
 * A Gmail failure is rethrown as it is, or with a message that adds context through
 * withContext, so the caller's error text keeps Gmail's reason, status and rejected
 * parameters.
 */

import { withContext } from './error-text.js';

// Type definitions for Gmail API labels
export interface GmailLabel {
    id: string;
    name: string;
    type?: string;
    messageListVisibility?: string;
    labelListVisibility?: string;
    messagesTotal?: number;
    messagesUnread?: number;
    color?: {
        textColor?: string;
        backgroundColor?: string;
    };
}

/**
 * Creates a new Gmail label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The newly created label
 */
export async function createLabel(gmail: any, labelName: string, options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
} = {}) {
    try {
        // Default visibility settings if not provided
        const messageListVisibility = options.messageListVisibility || 'show';
        const labelListVisibility = options.labelListVisibility || 'labelShow';

        const response = await gmail.users.labels.create({
            userId: 'me',
            requestBody: {
                name: labelName,
                messageListVisibility,
                labelListVisibility,
            },
        });

        return response.data;
    } catch (error: any) {
        // Handle duplicate labels more gracefully
        if (error.message && error.message.includes('already exists')) {
            throw withContext(`Label "${labelName}" already exists. Please use a different name.`, error);
        }

        throw error;
    }
}

/**
 * Updates an existing Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to update
 * @param updates - Properties to update
 * @returns The updated label
 */
export async function updateLabel(gmail: any, labelId: string, updates: {
    name?: string;
    messageListVisibility?: string;
    labelListVisibility?: string;
}) {
    try {
        // Verify the label exists before updating
        await gmail.users.labels.get({
            userId: 'me',
            id: labelId,
        });

        const response = await gmail.users.labels.update({
            userId: 'me',
            id: labelId,
            requestBody: updates,
        });

        return response.data;
    } catch (error: any) {
        if (error.code === 404) {
            throw withContext(`Label with ID "${labelId}" not found.`, error);
        }

        throw error;
    }
}

/**
 * Deletes a Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to delete
 * @returns Success message
 */
export async function deleteLabel(gmail: any, labelId: string) {
    try {
        // Ensure we're not trying to delete system labels
        const label = await gmail.users.labels.get({
            userId: 'me',
            id: labelId,
        });
        
        if (label.data.type === 'system') {
            throw new Error(`Cannot delete system label with ID "${labelId}".`);
        }
        
        await gmail.users.labels.delete({
            userId: 'me',
            id: labelId,
        });

        return { success: true, message: `Label "${label.data.name}" deleted successfully.` };
    } catch (error: any) {
        if (error.code === 404) {
            throw withContext(`Label with ID "${labelId}" not found.`, error);
        }

        throw error;
    }
}

/**
 * Gets a detailed list of all Gmail labels
 * @param gmail - Gmail API instance
 * @returns Object containing system and user labels
 */
export async function listLabels(gmail: any) {
    const response = await gmail.users.labels.list({
        userId: 'me',
    });

    const labels = response.data.labels || [];

    // Group labels by type for better organization
    const systemLabels = labels.filter((label:GmailLabel) => label.type === 'system');
    const userLabels = labels.filter((label:GmailLabel) => label.type === 'user');

    return {
        all: labels,
        system: systemLabels,
        user: userLabels,
        count: {
            total: labels.length,
            system: systemLabels.length,
            user: userLabels.length
        }
    };
}

/**
 * Finds a label by name
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to find
 * @returns The found label or null if not found
 */
export async function findLabelByName(gmail: any, labelName: string) {
    const labelsResponse = await listLabels(gmail);
    const allLabels = labelsResponse.all;

    // Case-insensitive match
    const foundLabel = allLabels.find(
        (label: GmailLabel) => label.name.toLowerCase() === labelName.toLowerCase()
    );

    return foundLabel || null;
}

/**
 * Creates label if it doesn't exist or returns existing label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The new or existing label
 */
export async function getOrCreateLabel(gmail: any, labelName: string, options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
} = {}) {
    // First try to find an existing label
    const existingLabel = await findLabelByName(gmail, labelName);

    if (existingLabel) {
        return existingLabel;
    }

    // If not found, create a new one
    return await createLabel(gmail, labelName, options);
}
