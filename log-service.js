// log-service.js
const fs = require('fs-extra');
const path = require('path');

// Use Glitch's persistent .data directory
const DATA_DIR = path.join(__dirname, '.data'); // Renamed for clarity
const LOG_FILE_PATH = path.join(DATA_DIR, 'events.log');
const COUNT_FILE_PATH = path.join(DATA_DIR, 'photo_count.txt'); // File to store the photo count


// Ensure the .data directory exists (fs-extra handles this well)
fs.ensureDirSync(DATA_DIR);

// --- Define Action Constants ---
// Makes calling the logger consistent and less prone to typos
const Actions = {
    VIEW_RECEIVER: 'VIEW_RECEIVER_PAGE',
    VIEW_SENDER: 'VIEW_SENDER_PAGE',
    UPLOAD_IMAGE: 'UPLOAD_IMAGE',
    DOWNLOAD_IMAGE: 'DOWNLOAD_IMAGE',
    SESSION_CREATED: 'SESSION_CREATED', // Optional: Log session start
    SESSION_CONNECTED: 'SESSION_CONNECTED', // Optional: Log sender connect
    SESSION_CLEANUP: 'SESSION_CLEANUP' // Optional: Log session end
};

/**
 * Logs an event to the persistent log file.
 * @param {string} ip - The client's IP address.
 * @param {string | null} sessionId - The session ID, if applicable.
 * @param {string} action - The action performed (use Actions constants).
 * @param {object | null} details - Optional additional details (e.g., { fileSize: 12345, imageId: 'xyz' }).
 */
async function logEvent(ip, sessionId, action, details = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        ip: ip || 'unknown', // Handle cases where IP might be missing
        sessionId: sessionId || null,
        action,
        details,
    };

    const logString = JSON.stringify(logEntry) + '\n'; // Add newline for easy parsing later

    try {
        // Append to the log file asynchronously
        await fs.appendFile(LOG_FILE_PATH, logString);
    } catch (error) {
        // If logging to file fails, log the error to the console instead
        console.error(`[Log Service Error] Failed to write to ${LOG_FILE_PATH}:`, error);
        console.error('[Log Service Error] Original log entry:', logEntry);
    }
}

// --- Photo Counter Functions ---

/**
 * Reads the current photo count from the count file.
 * If the file doesn't exist or contains invalid data, returns 0.
 * @returns {Promise<number>} The current photo count.
 */
async function readCurrentCount() {
    try {
        // Try reading the file
        const data = await fs.readFile(COUNT_FILE_PATH, 'utf8');
        const count = parseInt(data, 10);
        // Return the parsed count if it's a valid number, otherwise 0
        return isNaN(count) ? 0 : count;
    } catch (error) {
        // If the file doesn't exist (ENOENT), it's the first time, return 0
        if (error.code === 'ENOENT') {
            return 0;
        }
        // For any other read error, log it and return 0 as a fallback
        console.error(`[Photo Counter] Error reading count file ${COUNT_FILE_PATH}:`, error);
        return 0;
    }
}

/**
 * Increments the photo count stored in the persistent file.
 * Reads the current count, adds 1, and writes the new value back.
 * Creates the file if it doesn't exist.
 * @returns {Promise<number | null>} The *new* photo count after incrementing, or null if writing failed.
 */
async function photoUploaded() {
    // Get the current count first
    const currentCount = await readCurrentCount();
    const newCount = currentCount + 1;

    try {
        // Write the new count back to the file (as a string)
        // fs.writeFile overwrites the file or creates it if it doesn't exist.
        await fs.writeFile(COUNT_FILE_PATH, String(newCount));
        console.log(`[Photo Counter] Incremented photo count to: ${newCount}`);
        return newCount; // Return the new count
    } catch (error) {
        console.error(`[Photo Counter] Error writing new count (${newCount}) to ${COUNT_FILE_PATH}:`, error);
        return null; // Indicate failure
    }
}

/**
 * Retrieves the current photo count without modifying it.
 * Useful for displaying the count or using it elsewhere.
 * @returns {Promise<number>} The current photo count.
 */
async function getPhotoCount() {
    // Simply read the current count using the helper function
    const count = await readCurrentCount();
    return count;
}

// Export the function and constants for use in server.js
module.exports = {
    logEvent,
    Actions,
    photoUploaded,  // <-- Export the new function
    getPhotoCount,  // <-- Export the new function
};

console.log(`[Log Service] Initialized. Logging events to: ${LOG_FILE_PATH}`);