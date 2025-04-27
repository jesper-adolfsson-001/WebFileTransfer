// Import necessary libraries
const fastify = require('fastify')({
  logger: false, // Keep the logger instance enabled so fastify.log works
  disableRequestLogging: true, // Add this flag to disable the automatic logs
  trustProxy: true // Trust the immediate upstream proxy (Glitch's setup)
});
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const mime = require('mime-types');

// --- Import the Log Service ---
const { logEvent, Actions, photoUploaded, getPhotoCount } = require('./log-service'); // Add this line

// Configuration
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS, 10) || 120000; // 120 seconds
const CLIENT_TIMEOUT_MS = parseInt(process.env.CLIENT_TIMEOUT_MS, 10) || 3000; // 3 seconds
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '.data', 'uploads');
const ADMIN_CREDENTIALS = process.env.ADMIN_CREDENTIALS; // e.g., "admin:password123"
const POLLING_INTERVAL_MS = 2000; // How often clients should poll (informational for client)
const CLEANUP_INTERVAL_MS = 60000; // How often server checks for expired sessions
const LOG_FILE_PATH = path.join(__dirname, '.data', 'events.log'); // Make sure path is accessible here

const glitchImageUrl = 'https://cdn.glitch.global/7a08d29a-3fe4-44c5-8a06-ff5e944d8c35/QuickBeam_Logo.png?v=1744798242240'

// Ensure upload directory exists
try {
    fs.ensureDirSync(UPLOAD_DIR);
    fastify.log.info(`Upload directory ensured: ${UPLOAD_DIR}`);
} catch (err) {
    fastify.log.error(`Failed to ensure upload directory: ${UPLOAD_DIR}`, err);
    process.exit(1);
}

// In-memory store for active sessions
// Structure: { sessionId: { status: string, receiverLastSeen: number, senderLastSeen: number, expiresAt: number, imagePaths: { [imageId: string]: string }, pendingImageIds: string[], qrUrl: string, qrData: string, createdAt: number } }
const sessions = {};

// Register Fastify plugins
fastify.register(require('@fastify/view'), {
  engine: { ejs: require('ejs') },
  root: path.join(__dirname, 'views'),
});

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/public/',
});

fastify.register(require('@fastify/multipart'), {
    limits: { fileSize: 30 * 1024 * 1024 }
});

// --- Helper Functions ---

function calculateExpiresAt() {
    return Date.now() + SESSION_TIMEOUT_MS;
}

// Clean up session data and associated resources
async function cleanupSession(sessionId, reason) {
  const session = sessions[sessionId];
  if (!session) {
      // fastify.log.info({msg: 'Cleanup called on already cleaned/invalid session', sessionId, reason}); // Can be noisy
      return;
  }

  fastify.log.warn({ msg: 'Cleanup session initiated', sessionId, reason });

  // Remove session object *before* deleting files to prevent race conditions
  delete sessions[sessionId];
  fastify.log.info({ msg: 'Session object deleted from memory', sessionId });

  // Delete stored image files
  const imagePathsToDelete = Object.values(session.imagePaths || {});
  if (imagePathsToDelete.length > 0) {
      fastify.log.info({ msg: `Cleanup attempting to delete ${imagePathsToDelete.length} image file(s)`, sessionId, paths: imagePathsToDelete });
      for (const imagePath of imagePathsToDelete) {
          try {
              await fs.unlink(imagePath);
              fastify.log.info({ msg: `Cleaned up image file via cleanupSession`, sessionId, imagePath });
          } catch (err) {
              if (err.code !== 'ENOENT') {
                  fastify.log.error({ msg:`Error cleaning up image file during cleanupSession`, sessionId, imagePath, errorMessage: err.message });
              } else {
                  fastify.log.warn({ msg: `Image file already deleted when cleanupSession ran`, sessionId, imagePath });
              }
          }
      }
  } else {
      // fastify.log.info({ msg: 'Cleanup: No imagePaths associated with session to delete', sessionId });
  }
}

// --- Background Cleanup Task ---
function runExpiredSessionCleanup() {
    const now = Date.now();
    const sessionIds = Object.keys(sessions);
    let cleanedCount = 0;
    for (const sessionId of sessionIds) {
        const session = sessions[sessionId];
        if (session && session.expiresAt < now) {
            cleanupSession(sessionId, 'Expired via background cleanup task');
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        fastify.log.info(`Background cleanup task removed ${cleanedCount} expired sessions.`);
    }
}
setInterval(runExpiredSessionCleanup, CLEANUP_INTERVAL_MS); // Check every minute

async function checkAdminAuth(req, reply) {
    if (!ADMIN_CREDENTIALS) {
        fastify.log.error('ADMIN_CREDENTIALS environment variable not set!');
        reply.code(500).send({ success: false, message: 'Admin authentication not configured on server.' });
        // --- Add return ---
        return reply; // Stop processing
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        reply.code(401).header('WWW-Authenticate', 'Basic realm="Admin Area"').send({ success: false, message: 'Authentication required.' });
        // --- Add return ---
        return reply; // Stop processing
    }

    try {
        const token = authHeader.substring(6); // Remove "Basic " prefix
        const decoded = Buffer.from(token, 'base64').toString('utf8');

        if (decoded !== ADMIN_CREDENTIALS) {
            fastify.log.warn({ msg: 'Admin authentication failed', ip: req.ip, provided: decoded ? '******' : 'empty' });
            reply.code(401).header('WWW-Authenticate', 'Basic realm="Admin Area"').send({ success: false, message: 'Invalid credentials.' });
            // --- Add return ---
            return reply; // Stop processing
        }
        // If successful, do nothing, request processing continues
        fastify.log.info({ msg: 'Admin authentication successful', user: decoded.split(':')[0], ip: req.ip });
        // --- IMPORTANT: Do NOT return here if auth is successful ---
        // Allow processing to continue to the main route handler

    } catch (e) {
        fastify.log.error({ msg: 'Error decoding admin auth token', error: e.message });
        reply.code(400).send({ success: false, message: 'Invalid authentication token format.' });
        // --- Add return ---
        return reply; // Stop processing
    }
}


// --- REST API Routes ---

// 1. Receiver requests pairing
fastify.post('/api/session/request', async (req, reply) => {
    const sessionId = uuidv4();
    const now = Date.now();
    const expiresAt = calculateExpiresAt();
  
    const getFirstHeaderValue = (value) => {
      if (!value) return null;
      return value.split(',')[0].trim();
    };

    const protocol = getFirstHeaderValue(req.headers['x-forwarded-proto']) || 'https';
    const host = getFirstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host;

    const fullUrl = `${protocol}://${host}/sender?SessionId=${encodeURIComponent(sessionId)}`;
    fastify.log.info({ msg: 'From ', protocol: protocol, host: host});
  
    // const fullUrl = `https://quickbeam.app/sender?SessionId=${encodeURIComponent(sessionId)}`; // Use quickbeam domain
    // const fullUrl = `https://${process.env.PROJECT_DOMAIN}.glitch.me/sender?SessionId=${encodeURIComponent(sessionId)}`; // Use Glitch domain
    fastify.log.info({ msg: 'Processing requestPairing REST', generatedSessionId: sessionId, ip: req.ip });

    try {
        const qrCodeDataUrl = await QRCode.toDataURL(fullUrl);

        sessions[sessionId] = {
            status: 'waiting_for_sender', // Initial status
            receiverLastSeen: now,
            senderLastSeen: 0, // Sender hasn't connected yet
            expiresAt: expiresAt,
            imagePaths: {},
            pendingImageIds: [], // Images uploaded but not yet fetched by receiver status poll
            qrUrl: fullUrl,
            qrData: qrCodeDataUrl,
            createdAt: now
        };

        reply.code(201).send({
            success: true,
            sessionId: sessionId,
            fullURL: fullUrl,
            qrCodeData: qrCodeDataUrl,
            timeoutMs: SESSION_TIMEOUT_MS,
            pollingIntervalMs: POLLING_INTERVAL_MS // Inform client how often to poll
        });
         fastify.log.info({ msg: `Session created via REST, QR sent to receiver`, sessionId });

    } catch (qrError) {
        fastify.log.error({ msg: 'QR Code generation failed', sessionId, error: qrError.message, ip: req.ip });
        reply.code(500).send({ success: false, message: 'Failed to generate QR code.' });
    }
});

// 2. Sender connects using Session ID
fastify.post('/api/session/:sessionId/connect', async (req, reply) => {
    const { sessionId } = req.params;
    const now = Date.now();
    const session = sessions[sessionId];
    fastify.log.info({ msg: 'Sender connect REST attempt', sessionId, ip: req.ip });

    if (!session) {
        fastify.log.warn({ msg: 'Sender connect failed: Invalid session ID', attemptedSessionId: sessionId, ip: req.ip });
        return reply.code(404).send({ success: false, message: 'Invalid or expired session ID.' });
    }

    if (session.status !== 'waiting_for_sender') {
         // Could be 'connected', 'receiver_disconnected', 'sender_disconnected' etc.
         // Allow reconnect if status indicates sender dropped? For now, let's be strict.
         if (session.status === 'connected' && session.senderLastSeen > 0) {
             fastify.log.warn({ msg: 'Sender connect failed: Session already has an active sender', sessionId, ip: req.ip });
             return reply.code(409).send({ success: false, message: 'Session already has an active sender.' });
         }
         // Allow sender to connect if receiver disconnected? Maybe. Let's allow it for now.
         // if (session.status === 'receiver_disconnected') { // Allow connect if only receiver dropped }
    }

    // Update session state
    session.status = 'connected';
    session.senderLastSeen = now;
    session.expiresAt = calculateExpiresAt(); // Reset timer on successful connect

    fastify.log.info({ msg: `Sender connected successfully via REST`, sessionId, ip: req.ip });
    reply.code(200).send({
        success: true,
        sessionId: sessionId,
        timeoutMs: SESSION_TIMEOUT_MS,
        pollingIntervalMs: POLLING_INTERVAL_MS // Inform client how often to poll
    });
});

// 3. Receiver and Sender poll for status / keep-alive, this was GET before but that got cached by fastly so changed to POST
fastify.post('/api/session/:sessionId/status', async (req, reply) => {
    const { sessionId } = req.params;
    const clientType = req.query.client; // 'receiver' or 'sender'
    const session = sessions[sessionId];
    const now = Date.now();
    const photoCount =  await getPhotoCount();   

    // --- Validation ---
    if (!clientType || (clientType !== 'receiver' && clientType !== 'sender')) {
        return reply.code(400).send({ success: false, message: 'Missing or invalid client type query parameter.' });
    }
    if (!session) {
        // Don't log warn here, client might poll after session ends normally
        // fastify.log.warn({ msg: 'Status poll: Session not found', sessionId, clientType, ip: req.ip });
        return reply.code(404).send({ success: false, message: 'Session not found or expired.' });
    }

    // --- Update Last Seen & Check Expiry ---
    let otherClientDisconnected = false;
    if (clientType === 'receiver') {
        session.receiverLastSeen = now;
        if (session.status === 'connected' && now > session.senderLastSeen + CLIENT_TIMEOUT_MS) {
            session.status = 'sender_disconnected';
            otherClientDisconnected = true;
            fastify.log.warn({ msg: 'Sender timed out based on receiver poll', sessionId });
        }
    } else { // clientType === 'sender'
        session.senderLastSeen = now;
         if (session.status === 'connected' && now > session.receiverLastSeen + CLIENT_TIMEOUT_MS) {
            session.status = 'receiver_disconnected';
            otherClientDisconnected = true;
             fastify.log.warn({ msg: 'Receiver timed out based on sender poll', sessionId });
        }
    }

    // If session expired overall, trigger cleanup and inform client
    if (session.expiresAt < now) {
        cleanupSession(sessionId, 'Expired on status poll');
        return reply.code(404).send({ success: false, message: 'Session expired.' });
    }

    // --- Prepare Response ---
    const responsePayload = {
        success: true,
        sessionStatus: session.status,
        partnerConnected: false, // Default assumption
        remainingTimeoutMs: Math.max(0, session.expiresAt - now),
        newImageIds: [], // Only populated for receiver
        photoCount: Math.max(0, photoCount),
    };
    
    fastify.log.info("photoCount:",photoCount);

    // Determine partner status for the response
    if (session.status === 'connected') {
        responsePayload.partnerConnected = true;
    } else if (clientType === 'receiver' && session.status === 'sender_disconnected') {
         responsePayload.partnerConnected = false; // Sender dropped
    } else if (clientType === 'sender' && session.status === 'receiver_disconnected') {
         responsePayload.partnerConnected = false; // Receiver dropped
    }
    // If waiting_for_sender, partner isn't connected yet.

    // If receiver is polling, give them the list of pending image IDs
    if (clientType === 'receiver' && session.pendingImageIds.length > 0) {
        responsePayload.newImageIds = [...session.pendingImageIds]; // Copy the array
        session.pendingImageIds = []; // Clear the pending list for this session
        fastify.log.info({ msg: 'Delivering pending image IDs to receiver poll', sessionId, count: responsePayload.newImageIds.length, imageIds: responsePayload.newImageIds });
    }

    // Log poll activity occasionally or on state changes? For now, minimal logging.
    // if (timerReset || otherClientDisconnected) {
    //     fastify.log.info({ msg: 'Status poll update', sessionId, clientType, status: session.status, timerReset, otherClientDisconnected, ip: req.ip });
    // }

    reply.code(200).send(responsePayload);
});





// --- HTTP Routes (Static Files & Views) ---

const renderReceiverPage = (req, reply) => {
  
  // --- Log Page View ---
  logEvent(req.ip, null, Actions.VIEW_RECEIVER); // Session ID not known yet
  // --- End Log ---
  
  fastify.log.info({ msg: 'Serving Receiver Page', ip: req.ip });
  reply.view('receiver.ejs', {
    title: 'QuickBeam: Easy Photo Transfer Between Devices via QR Code',
    SESSION_TIMEOUT_MS: SESSION_TIMEOUT_MS, // Pass timeout for initial display logic
    POLLING_INTERVAL_MS: POLLING_INTERVAL_MS // Pass polling interval
  });
};

['/', '/index.html', '/receiver'].forEach(route => {
  fastify.get(route, renderReceiverPage);
});

fastify.get('/sender', (req, reply) => {
  const sessionId = req.query.SessionId; // Get SessionId from query param
  
  // --- Log Page View ---
  logEvent(req.ip, sessionId || null, Actions.VIEW_SENDER); // Log with session ID if present
  // --- End Log ---
  
   if (!sessionId || !sessions[sessionId]) {
        fastify.log.warn({ msg: 'Sender page access attempt with invalid/expired SessionId', sessionId, ip: req.ip });
        // Redirect or show error page? Showing standard page, JS will handle connect error.
        // return reply.code(404).send('Invalid or expired Session ID.');
   }
  fastify.log.info({ msg: 'Serving Sender Page', sessionId, ip: req.ip });
  reply.view('sender.ejs', {
      // title: 'Sender Page',
      // Pass session ID and polling interval to the template if needed by JS directly
      // Although JS will get it from the URL anyway for connect.
      // SESSION_ID: sessionId,
      POLLING_INTERVAL_MS: POLLING_INTERVAL_MS
  });
});

// Image Upload Endpoint (used by Sender)
fastify.post('/upload', async (req, reply) => {
  
  // Be positive and hope the photo will upload for our counter so it increases a lot :)
  photoUploaded();
  
  const sessionId = req.query.sessionId;
  fastify.log.info({ msg: 'Upload POST request received', sessionId, ip: req.ip });

  const session = sessions[sessionId];
  const now = Date.now();

  // --- Validation ---
  if (!sessionId || !session) {
    fastify.log.warn({ msg: 'Upload rejected: Invalid session ID', sessionId, ip: req.ip });
    return reply.code(400).send({ success: false, message: 'Missing, invalid or expired session ID.' });
  }

   // Check session status - must be connected or maybe allow if only receiver dropped? Let's stick to 'connected' for simplicity.
  if (session.status !== 'connected') {
      fastify.log.warn({ msg: 'Upload rejected: Session not in connected state', sessionId, status: session.status, ip: req.ip });
      let userMessage = 'Session is not active or receiver is disconnected.';
      if (session.status === 'waiting_for_sender') userMessage = 'Sender has not connected yet.';
      return reply.code(400).send({ success: false, message: userMessage });
  }

   // Check if receiver has timed out recently
   if (now > session.receiverLastSeen + SESSION_TIMEOUT_MS) {
       session.status = 'receiver_disconnected'; // Update status proactively
       fastify.log.warn({ msg: 'Upload rejected: Receiver timed out just before upload', sessionId, ip: req.ip });
       cleanupSession(sessionId, 'Receiver timed out before upload could complete'); // Clean up session
       return reply.code(400).send({ success: false, message: 'Receiver partner disconnected.' });
   }

   // --- Reset session timeout on successful upload activity ---
   session.expiresAt = calculateExpiresAt(); // Update expiry time
   fastify.log.info({ msg: 'Reset session inactivity timeout on upload', sessionId });

  // --- Process Upload ---
  let data;
  try {
    data = await req.file();
    if (!data) {
        fastify.log.warn({ msg: 'Upload rejected: No file data in request', sessionId, ip: req.ip });
        return reply.code(400).send({ success: false, message: 'No file uploaded.' });
    }

    const originalFilename = data.filename ? path.basename(data.filename) : 'uploaded-image';
    const imageId = `${uuidv4()}-${originalFilename}`;
    const imagePath = path.join(UPLOAD_DIR, imageId);
    fastify.log.info({ msg: 'Generated image path for upload', sessionId, imageId, imagePath, ip: req.ip });

    const imageBufferForSize = await data.toBuffer(); // Get buffer to determine size
    await fs.writeFile(imagePath, imageBufferForSize);
    fastify.log.info({ msg: 'Image file successfully written to disk', sessionId, imagePath, ip: req.ip });
    
    const fileSize = imageBufferForSize.length; // Get the size

    // Store image path mapped by its ID
    session.imagePaths[imageId] = imagePath;
    // Add to pending list for receiver poll
    session.pendingImageIds.push(imageId);
    fastify.log.info({ msg: 'Added new image to session maps (paths and pending)', sessionId, imageId, pendingCount: session.pendingImageIds.length });
    
    // --- Log Upload Event ---
    logEvent(req.ip, sessionId, Actions.UPLOAD_IMAGE, { imageId: imageId, fileSize: fileSize });
    // --- End Log ---

    

    reply.code(200).send({ success: true, message: `File ${originalFilename} uploaded successfully.` });

  } catch (error) {
    fastify.log.error({ msg: 'Image upload processing error', errorMessage: error.message, code: error.code, sessionId, ip: req.ip });
     if (error.code === 'FST_FILES_LIMIT' || error.code === 'FST_PARTS_LIMIT' || (error.code === 'ERR_STREAM_PREMATURE_CLOSE' && req.isMultipartLimitError) || error.message.toLowerCase().includes('limit')) {
        return reply.code(413).send({ success: false, message: `File upload error: Limit exceeded. ${error.message}` });
     }
    // Don't add to pending if write failed
    return reply.code(500).send({ success: false, message: `Failed to process upload: ${error.message}` });
  }
});


// Image Retrieval Endpoint (used by Receiver) - Accepts imageId
fastify.get('/image/:sessionId/:imageId', async (req, reply) => {
    const { sessionId, imageId } = req.params;
    fastify.log.info({ msg: 'Image GET request received', sessionId, imageId, ip: req.ip });

    const session = sessions[sessionId];

    // --- Validation ---
    // Allow fetch even if session expired/cleaned? Maybe not, file might be gone. Be strict.
    if (!sessionId || !session) {
        fastify.log.warn({ msg: 'Image GET failed: Session not found', sessionId, imageId, ip: req.ip });
        return reply.code(404).send({ success: false, message: 'Image not found or session invalid.' });
    }

    const imagePath = session.imagePaths[imageId];
    fastify.log.info({ msg: 'Image GET: Session found, checking imagePath for imageId', sessionId, imageId, currentImagePathInSession: imagePath, ip: req.ip });

    if (!imagePath) {
         fastify.log.warn({ msg: 'Image GET failed: imageId not found in session path map', sessionId, imageId, ip: req.ip });
         return reply.code(404).send({ success: false, message: 'Image not found (invalid image ID for this session).' });
    }

    // --- Serve File (Using Buffering) ---
    try {
        await fs.access(imagePath, fs.constants.R_OK);
        const imageBuffer = await fs.readFile(imagePath);
        const mimeType = mime.lookup(imagePath) || 'application/octet-stream';
        const fileSize = imageBuffer.length; // Get file size
        
      // --- Log Download Event ---
        // Log *before* sending, in case sending causes issues/long delays
        logEvent(req.ip, sessionId, Actions.DOWNLOAD_IMAGE, { imageId: imageId, fileSize: fileSize });
        // --- End Log ---
      
        reply
          .code(200)
          .header('Content-Type', mimeType)
          .header('Content-Length', imageBuffer.length)
          .send(imageBuffer);

        fastify.log.info({ msg: 'Image GET: Buffered response sending initiated', sessionId, imageId, mimeType, size: imageBuffer.length, ip: req.ip });

        // --- Cleanup AFTER sending ---
        process.nextTick(async () => {
             try {
                 fastify.log.info({ msg: 'Image GET: Attempting post-send cleanup', sessionId, imageId, imagePath });
                 await fs.unlink(imagePath);
                 fastify.log.info({ msg: `Successfully deleted image after sending`, sessionId, imageId, imagePath });
                 // Remove the entry from the session map *if the session still exists*
                 // Check needed because session might have timed out between GET and cleanup
                 const currentSession = sessions[sessionId];
                 if (currentSession && currentSession.imagePaths[imageId]) {
                     delete currentSession.imagePaths[imageId];
                     // No need to manage pendingImageIds here, that's done by status poll
                     fastify.log.info({ msg: `Removed image path from session map`, sessionId, imageId, remainingImages: Object.keys(currentSession.imagePaths).length });
                 } else {
                      fastify.log.warn({ msg: `Session or imageId entry gone before post-send map cleanup`, sessionId, imageId });
                 }
             } catch (unlinkError) {
                 if (unlinkError.code !== 'ENOENT') {
                    fastify.log.error({ msg:`Error deleting image after sending`, sessionId, imageId, imagePath, errorMessage: unlinkError.message });
                 } else {
                    fastify.log.warn({ msg: `Image already deleted during post-send cleanup`, sessionId, imageId, imagePath });
                 }
             }
        });

    } catch (error) {
        if (error.code === 'ENOENT') {
             fastify.log.warn(`Image GET failed: File not found (ENOENT on access/read)`, { sessionId, imageId, imagePath, error: error.message, ip: req.ip });
             reply.code(404).send({ success: false, message: 'Image file not found.' });
        } else if (error instanceof Error && error.message.includes('cannot be larger than')) {
             fastify.log.error({ msg: 'Image GET: Error reading file into buffer (likely too large)', sessionId, imageId, imagePath, error: error.message, ip: req.ip });
             reply.code(500).send({ success: false, message: 'Failed to read image file (too large).' });
        } else {
            fastify.log.error({ msg: 'Image GET: Error during file access/read', sessionId, imageId, imagePath, error: error.message, ip: req.ip });
            reply.code(500).send({ success: false, message: `Failed to retrieve image: ${error.message}` });
        }
    }
});

// --- Admin Page Route ---
fastify.get('/admin', { preHandler: [checkAdminAuth] }, async (req, reply) => {
    // checkAdminAuth hook runs first if successful
    fastify.log.info('Admin route handler starting, attempting to render view...'); // Add log
    try {
        // --- Await the view rendering ---
        await reply
          .header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
          .header('Pragma', 'no-cache')
          .header('Expires', '0')
          .header('Surrogate-Control', 'no-store') // This is respected by Fastly
          .view('admin.ejs');
        // If await completes without error, the reply has been sent by reply.view.
        // No 'return reply' is needed here when using await.
        fastify.log.info('Admin view rendering completed successfully via await.'); // Add log
    } catch (viewError) {
        // Log the error if rendering fails
        fastify.log.error({ msg: 'Error occurred during reply.view rendering', error: viewError });
        // Allow Fastify's default error handling to take over,
        // it will check if the reply was already sent.
        // If not sent, it will send a 500 error.
        // Rethrow the error to ensure Fastify handles it.
        throw viewError;
    }
    // --- DO NOT return reply here ---
});

// --- Admin Logout Route ---
// This route forces the browser to clear cached Basic Auth credentials
// by sending a 401 Unauthorized response.
fastify.get('/admin/logout', async (req, reply) => {
    fastify.log.info({ msg: 'Admin logout initiated', ip: req.ip });
    // Send 401 Unauthorized with the correct WWW-Authenticate header
    // This mimics the initial challenge, prompting the browser to ask for credentials again.
    reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="Admin Area"') // MUST match the realm used in checkAdminAuth
        .type('text/html') // Send a simple message
        .send('<html><body><h1>Logged Out</h1><p>You have been logged out. Please close this browser window/tab for security.</p></body></html>');

    // IMPORTANT: No 'return reply' needed here as we explicitly used .send()
});

// --- API Endpoint to Fetch Logs ---
fastify.get('/api/logs', { preHandler: [checkAdminAuth] }, async (req, reply) => {
    // checkAdminAuth hook runs first
    const { page = 1, limit = 50, sort = 'timestamp', order = 'desc' } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
        return reply.code(400).send({ success: false, message: 'Invalid page or limit parameter.' });
    }

    try {
        // Check if log file exists
        const fileExists = await fs.pathExists(LOG_FILE_PATH);
        if (!fileExists) {
            fastify.log.warn({ msg: 'Log file not found on API request', path: LOG_FILE_PATH });
            return reply.code(200).send({ // Send success but empty data
                success: true,
                logs: [],
                currentPage: 1,
                totalPages: 0,
                totalLogs: 0,
            });
        }

        // Read the entire log file
        const logData = await fs.readFile(LOG_FILE_PATH, 'utf8');
        const lines = logData.split('\n').filter(line => line.trim() !== ''); // Split and remove empty lines

        // Parse each line into a JSON object
        const allLogs = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                fastify.log.warn({ msg: 'Failed to parse log line, skipping', line: line, error: e.message });
                return null; // Mark invalid lines
            }
        }).filter(log => log !== null); // Remove lines that failed to parse

        // Sort the logs
        allLogs.sort((a, b) => {
            let valA = a[sort];
            let valB = b[sort];

            // Handle timestamp sorting correctly (ISO strings compare lexicographically)
            // Handle other potential types if needed (e.g., numbers for fileSize)
            if (sort === 'sessionId' || sort === 'ip' || sort === 'action') {
                 // Case-insensitive string sort
                 valA = String(valA || '').toLowerCase();
                 valB = String(valB || '').toLowerCase();
            }

            if (valA < valB) return order === 'asc' ? -1 : 1;
            if (valA > valB) return order === 'asc' ? 1 : -1;
            return 0;
        });

        // Calculate pagination
        const totalLogs = allLogs.length;
        const totalPages = Math.ceil(totalLogs / limitNum);
        const offset = (pageNum - 1) * limitNum;
        const paginatedLogs = allLogs.slice(offset, offset + limitNum);

        reply.code(200).send({
            success: true,
            logs: paginatedLogs,
            currentPage: pageNum,
            totalPages: totalPages,
            totalLogs: totalLogs,
        });

    } catch (error) {
        fastify.log.error({ msg: 'Error reading or processing log file', error: error.message, stack: error.stack });
        reply.code(500).send({ success: false, message: 'Failed to read or process logs.' });
    }
});



// --- Start the Server ---
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port: port, host: '0.0.0.0' });
    // Log after listen is successful
    // fastify.log.info(`Server listening on port ${fastify.server.address().port}`); // Already logged by default logger
  } catch (err) {
    fastify.log.error('Error starting server:', err);
    process.exit(1);
  }
};

start();