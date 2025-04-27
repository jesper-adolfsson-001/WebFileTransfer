console.log("Sender client script loaded (REST/Polling Version).");

// UI Elements
const statusDiv = document.getElementById('status');
const uploadSection = document.getElementById('upload-section');
const sessionIdSpan = document.getElementById('session-id');
const cameraButton = document.getElementById('cameraBtn');
const fileButton = document.getElementById('fileBtn');
const cameraInput = document.getElementById("cameraInput");
const fileInput = document.getElementById("fileInput");
const uploadStatusDiv = document.getElementById('upload-status');
const previewImg = document.getElementById('preview');

// Session Variables
let currentSessionId = null;
let pollingIntervalMs = window.CONFIG?.POLLING_INTERVAL_MS || 2000;
let statusPollIntervalId = null;
let isReceiverConnected = false; // Track receiver connection state


// --- Get Session ID from URL ---
function getSessionIdFromUrl() {
  try {
      const urlParams = new URLSearchParams(window.location.search);
      currentSessionId = urlParams.get('SessionId');
      if (!currentSessionId) {
        throw new Error("SessionId parameter not found in URL.");
      }
      console.log("Found Session Id in URL:", currentSessionId);
      // Attempt to connect using this ID
      connectToSession();
  } catch (error) {
      console.error("Error getting Session ID:", error);
      statusDiv.textContent = "Error: Could not find a valid Session ID in the URL. Please scan the QR code again.";
      statusDiv.classList.add('error');
      uploadSection.style.display = 'none';
  }
}

// --- 1. Connect to Session via REST ---
async function connectToSession() {
    if (!currentSessionId) {
        console.error("Cannot connect without Session ID.");
        statusDiv.textContent = "Error: No Session ID available.";
        statusDiv.classList.add('error');
        return;
    }

    console.log(`Attempting to connect to session ${currentSessionId}...`);
    statusDiv.textContent = 'Connecting to session...';
    statusDiv.classList.remove('error');

    try {
        const response = await fetch(`/api/session/${currentSessionId}/connect`, { method: 'POST' });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.message || `Connect failed: HTTP ${response.status}`);
        }

        // SUCCESS
        currentSessionId = data.sessionId; // Confirm session ID from server
        pollingIntervalMs = data.pollingIntervalMs || pollingIntervalMs;

        statusDiv.textContent = 'Successfully connected to receiver session!';
        sessionIdSpan.textContent = currentSessionId;
        uploadSection.style.display = 'block';
        uploadStatusDiv.textContent = 'Ready to send images.';
        uploadStatusDiv.classList.remove('error');
        previewImg.style.display = 'none';
        isReceiverConnected = true; // Assume connected initially

        // Start polling for status updates
        startStatusPolling();

    } catch (error) {
        console.error('Failed to connect to session:', error);
        statusDiv.textContent = `Error connecting: ${error.message}. Please scan the QR code again.`;
        statusDiv.classList.add('error');
        uploadSection.style.display = 'none';
        clearInterval(statusPollIntervalId); // Stop polling if connect failed
    }
}

// --- 2. Poll for Session Status ---
async function pollSessionStatus() {
    if (!currentSessionId) {
        console.warn("Polling stopped: No active session ID.");
        clearInterval(statusPollIntervalId);
        return;
    }

    // console.log("Polling sender status..."); // Noisy, don't use GET since it caches on fastly
    try {
        const response = await fetch(`/api/session/${currentSessionId}/status?client=sender`, {
          method: 'POST',
        });

        if (response.status === 404) {
             console.warn("Session not found during polling (404). Stopping poll.");
             statusDiv.textContent = "Session expired or closed by server. Please scan a new QR code.";
             statusDiv.classList.add('error');
             uploadSection.style.display = 'none';
             clearInterval(statusPollIntervalId);
             return;
        }

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.message || `Status poll HTTP error ${response.status}`);
        }

        // Update based on status
        switch (data.sessionStatus) {
            case 'connected':
                 if (!isReceiverConnected) {
                     statusDiv.textContent = 'Receiver reconnected. Ready to send images.';
                     uploadSection.style.display = 'block'; // Re-enable upload
                     uploadStatusDiv.textContent = 'Ready to send images.';
                      uploadStatusDiv.classList.remove('error');
                 } else {
                     // Still connected, ensure status message is neutral
                      statusDiv.textContent = 'Connected to receiver session.';
                 }
                 isReceiverConnected = true;
                 break;
            case 'receiver_disconnected':
                 if (isReceiverConnected) {
                     statusDiv.textContent = 'Receiver disconnected. Please close this window and scan a new QR code.';
                     statusDiv.classList.add('error'); // Use error style for warning
                     uploadStatusDiv.style.display = 'none';
                     uploadStatusDiv.textContent = 'Upload disabled - Receiver disconnected.';
                     uploadStatusDiv.classList.add('error');
                     // Keep polling, receiver might come back
                     // Optionally disable upload buttons
                     uploadSection.style.display = 'none'; // Or just disable buttons?
                 }
                 isReceiverConnected = false;
                 break;
            case 'waiting_for_sender': // Should not happen after successful connect, but handle defensively
            case 'sender_disconnected': // Should not happen if this client is polling
            case 'expired': // Should be caught by 404
                 console.warn(`Unexpected session status ${data.sessionStatus} received by sender. Stopping poll.`);
                 statusDiv.textContent = "Session ended or in unexpected state. Please close this window and scan a new QR code.";
                 statusDiv.classList.add('error');
                 uploadSection.style.display = 'none';
                 clearInterval(statusPollIntervalId);
                 isReceiverConnected = false;
                 break;
            default:
                 console.warn("Unknown session status received:", data.sessionStatus);
                 statusDiv.textContent = `Unknown session state: ${data.sessionStatus}`;
                 statusDiv.classList.add('error');
                 isReceiverConnected = false; // Assume disconnected
        }

    } catch (error) {
         console.error('Sender status poll failed:', error);
         statusDiv.textContent = `Error checking session status: ${error.message}. Retrying...`;
         statusDiv.classList.add('error');
         isReceiverConnected = false; // Assume disconnected on error
         // Keep polling
    }
}

function startStatusPolling() {
    clearInterval(statusPollIntervalId);
    if (currentSessionId && pollingIntervalMs > 0) {
        console.log(`Starting sender status polling every ${pollingIntervalMs}ms for session ${currentSessionId}`);
        pollSessionStatus(); // Run immediately
        statusPollIntervalId = setInterval(pollSessionStatus, pollingIntervalMs);
    } else {
         console.error("Cannot start sender polling without session ID or valid interval.");
    }
}




// --- Image Upload Handling (mostly unchanged) ---

cameraButton.addEventListener("click", () => cameraInput.click());
fileButton.addEventListener("click", () => fileInput.click());

async function handleImageUpload(event) {
    const file = event.target.files[0];
    event.target.value = null; // Allow re-uploading same file

    if (!file) {
        console.warn("No file selected.");
        // uploadStatusDiv.textContent = 'No file selected.'; // Avoid clearing success message
        return;
    }

    if (!currentSessionId) {
        uploadStatusDiv.textContent = 'Error: No active session ID. Cannot upload.';
        uploadStatusDiv.classList.add('error');
        return;
    }

    // Check connectivity status from polling *before* attempting upload
    if (!isReceiverConnected) {
         uploadStatusDiv.textContent = 'Upload failed: Receiver is not connected.';
         uploadStatusDiv.classList.add('error');
         return;
    }

    let previewUrl = null;
    try {
        previewUrl = URL.createObjectURL(file);
        previewImg.src = previewUrl;
        previewImg.style.display = 'block';
    } catch (previewError) {
        console.error("Error creating object URL for preview:", previewError);
        previewImg.style.display = 'none';
    }

    uploadStatusDiv.textContent = `Uploading ${file.name}...`;
    uploadStatusDiv.classList.remove('error');
    cameraButton.disabled = true;
    fileButton.disabled = true;

    const formData = new FormData();
    formData.append('image', file);

    try {
        const uploadUrl = `/upload?sessionId=${currentSessionId}`;
        console.log(`Uploading to: ${uploadUrl}`);

        const response = await fetch(uploadUrl, { method: 'POST', body: formData });
        const result = await response.json();

        if (!response.ok || !result.success) {
           throw new Error(result.message || `Upload HTTP error! status: ${response.status}`);
        }

        uploadStatusDiv.textContent = `Success: ${result.message} You can send another image.`;
        console.log('Upload successful:', result);
        // Optionally clear preview after success?
        // previewImg.style.display = 'none';
        // if (previewUrl) URL.revokeObjectURL(previewUrl);


    } catch (error) {
        console.error('Upload failed:', error);
        uploadStatusDiv.textContent = `Upload failed: ${error.message}`;
        uploadStatusDiv.classList.add('error');
        // If error indicates receiver disconnected during upload, update state
        if (error.message.toLowerCase().includes('receiver') && error.message.toLowerCase().includes('disconnected')) {
             isReceiverConnected = false;
             pollSessionStatus(); // Force a status poll to update UI correctly
        }
    } finally {
         cameraButton.disabled = false;
         fileButton.disabled = false;
         // Clean up preview URL unless it was cleared on success above
         if (previewUrl && previewImg.style.display !== 'none') {
             URL.revokeObjectURL(previewUrl);
             console.log("Revoked preview object URL.");
         }
    }
}

cameraInput.addEventListener("change", handleImageUpload);
fileInput.addEventListener("change", handleImageUpload);


// --- Initialization ---
getSessionIdFromUrl(); // Start the process: get ID, connect, then poll.