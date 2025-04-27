console.log("Receiver client script loaded (REST/Polling Version).");

// UI Elements
const statusDiv = document.getElementById('status');
const qrCodeContainer = document.getElementById('qr-code-container');
const qrCodeImg = document.getElementById('qr-code-img');
const qrLoading = document.getElementById('qr-loading');
const sessionIdDisplay = document.getElementById('session-id-display');
const sessionTimerDisplay = document.getElementById('session-timer-display');
const imageTimerDisplay = document.getElementById('image-timer-display');
const pairingSection = document.getElementById('pairing-section');
const imageDisplaySection = document.getElementById('image-display-section');
const imageStatus = document.getElementById('image-status');
const receivedImagesContainer = document.getElementById('received-images-container');
const autoDownloadCheckbox = document.getElementById('autoDownloadCheckbox');
const photoCounter = document.getElementById('photo-counter');

// Session Variables
let currentSessionId = null;
let sessionTimeoutMs = window.CONFIG?.SESSION_TIMEOUT_MS || 120000;
let pollingIntervalMs = window.CONFIG?.POLLING_INTERVAL_MS || 2000;
let sessionTimerIntervalId = null; // For updating the timer display
let statusPollIntervalId = null; // For polling the server status
let isSenderConnected = false; // Track sender connection state

const AUTO_DOWNLOAD_STORAGE_KEY = 'quickbeam_autoDownloadEnabled';

// --- Functions for managing auto-download preference ---
function loadAutoDownloadPreference() {
    try {
        const savedValue = localStorage.getItem(AUTO_DOWNLOAD_STORAGE_KEY);

        // Default to false (unchecked) unless explicitly saved as 'true'
        const isEnabled = savedValue === 'true'; // Only true if it was specifically saved as 'true'

        autoDownloadCheckbox.checked = isEnabled;
        console.log(`[Prefs] Auto-download preference loaded: ${isEnabled}`);

    } catch (e) {
        console.error("[Prefs] Error loading preference from localStorage:", e);
        // Default to false (unchecked) in case of error
        autoDownloadCheckbox.checked = false;
    }
}

function saveAutoDownloadPreference() {
    try {
        const isEnabled = autoDownloadCheckbox.checked;
        localStorage.setItem(AUTO_DOWNLOAD_STORAGE_KEY, isEnabled.toString()); // Store as 'true' or 'false'
        console.log(`[Prefs] Auto-download preference saved: ${isEnabled}`);
    } catch (e) {
        console.error("[Prefs] Error saving preference to localStorage:", e);
    }
}

// --- Event Listener for Checkbox ---
if (autoDownloadCheckbox) {
    autoDownloadCheckbox.addEventListener('change', saveAutoDownloadPreference);
} else {
    console.error("Could not find autoDownloadCheckbox element.");
}

function updateStatus(message, isError = false) {
    console.log(`[Status] ${message}`);
    statusDiv.textContent = message;
    if (isError) {
        statusDiv.classList.add('error');
    } else {
        statusDiv.classList.remove('error');
    }
}

function updateImageStatus(message, isError = false) {
    console.log(`[ImageStatus] ${message}`);
    imageStatus.textContent = message;
     if (isError) {
        imageStatus.classList.add('error');
    } else {
        imageStatus.classList.remove('error');
    }
}

// Updates the visual timer countdown display
function startVisualTimer(durationMs) {
    clearInterval(sessionTimerIntervalId); // Clear previous timer
    let remainingSeconds = Math.floor(durationMs / 1000);

    function updateDisplay() {
        if (remainingSeconds >= 0) {
            const text = `Session active. Timeout in ${remainingSeconds}s...`;
            sessionTimerDisplay.textContent = text;
            imageTimerDisplay.textContent = text;
            remainingSeconds--;
        } else {
            sessionTimerDisplay.textContent = 'Session expired or timed out.';
            imageTimerDisplay.textContent = 'Session expired or timed out.';
            clearInterval(sessionTimerIntervalId); // Stop timer when it hits 0
        }
    }
    updateDisplay(); // Initial display
    sessionTimerIntervalId = setInterval(updateDisplay, 1000); // Update every second
}

function stopVisualTimer() {
     clearInterval(sessionTimerIntervalId);
     sessionTimerDisplay.textContent = 'Session inactive.';
     imageTimerDisplay.textContent = 'Session inactive.';
}

function resetUIForNewSession() {
    /*
    updateStatus("Requesting new session from server...");
    pairingSection.style.display = 'block';
    imageDisplaySection.style.display = 'none';
    qrLoading.style.display = 'block';
    qrLoading.textContent = 'Waiting for QR Code...';
    qrCodeImg.src = '';
    qrCodeImg.style.display = 'none';
    sessionIdDisplay.textContent = '';
    receivedImagesContainer.innerHTML = ''; // Clear previous images
    stopVisualTimer();
    clearInterval(statusPollIntervalId); // Stop any previous polling
    currentSessionId = null;
    isSenderConnected = false;
    */
  
    //window.odometerOptions = {format: '(,ddd)'};
    photoCounter.innerHTML = 100;
    setTimeout(function(){
      photoCounter.innerHTML = 654;
    }, 100);
    photoCounter.style.display = '';
    
  
}

// 1. Request a new session on load
async function requestNewSession() {
    // resetUIForNewSession();
    console.log("Requesting new session...");
    try {
        const response = await fetch('/api/session/request', { method: 'POST' });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.message || `HTTP error ${response.status}`);
        }

        currentSessionId = data.sessionId;
        sessionTimeoutMs = data.timeoutMs || sessionTimeoutMs;
        pollingIntervalMs = data.pollingIntervalMs || pollingIntervalMs;
      
        console.log("sessionTimeoutMs:",sessionTimeoutMs);
        console.log("pollingIntervalMs:",pollingIntervalMs);

        qrLoading.style.display = 'none';
        qrCodeImg.src = data.qrCodeData;
        qrCodeImg.style.display = 'block';
        sessionIdDisplay.textContent = `Sender URL: ${data.fullURL}`;
        updateStatus('QR Code received. Waiting for sender connection...');
        startVisualTimer(sessionTimeoutMs); // Start visual countdown

        // Start polling for status updates
        startStatusPolling();

    } catch (error) {
        console.error('Failed to request new session:', error);
        updateStatus(`Error creating session: ${error.message}. Please refresh.`, true);
        stopVisualTimer();
    }
}

// 2. Poll for session status
async function pollSessionStatus() {
    if (!currentSessionId) {
        console.warn("Polling stopped: No active session ID.");
        clearInterval(statusPollIntervalId);
        stopVisualTimer();
        return;
    }
  
    console.log("CurrentSessionId",currentSessionId );

    // console.log(`Polling status for session: ${currentSessionId}`); // Can be noisy, don't use get since it caches on fastly
    try {
        const response = await fetch(`/api/session/${currentSessionId}/status?client=receiver`, {
          method: 'POST',
        });

        if (response.status === 404) {
             // Session expired or cleaned up by server
             console.warn("Session not found during polling (404). Stopping poll.");
             updateStatus("Session expired or closed by server.", false);
             clearInterval(statusPollIntervalId);
             stopVisualTimer();
             // resetUIForNewSession(); // Optionally reset UI fully
             // Consider automatically requesting a new session after a delay?
             // setTimeout(requestNewSession, 5000);
            requestNewSession();
             return;
        }

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.message || `Status poll HTTP error ${response.status}`);
        }

        // Update visual timer based on server's remaining time
        startVisualTimer(data.remainingTimeoutMs);

        // Handle session status changes
        //console.log("data.sessionStatus:",data.sessionStatus);
        //console.log("sessionTimeoutMs",sessionTimeoutMs);
        switch (data.sessionStatus) {
            case 'waiting_for_sender':
                if (isSenderConnected) { // If sender was connected but dropped
                     isSenderConnected = false;
                     pairingSection.style.display = 'block'; // Show QR again
                     imageDisplaySection.style.display = 'none';
                     updateStatus('Sender disconnected. Waiting for sender connection...');
                     updateImageStatus('Sender disconnected.');
                } else {
                     // Still waiting, update status message if needed
                     updateStatus('QR Code ready. Waiting for sender connection...');
                }
                break;
            case 'connected':
                if (!isSenderConnected) {
                    isSenderConnected = true;
                    updateStatus('Sender connected successfully! Waiting for images...');
                    pairingSection.style.display = 'none'; // Hide QR section
                    imageDisplaySection.style.display = 'block'; // Show image section
                    imageTimerDisplay.style.display = 'block';
                    updateImageStatus('Ready to receive images.');
                } else {
                    // Update status in case it changed from error/idle
                     updateStatus('Sender connected. Waiting for images...');
                     updateImageStatus('Ready to receive images.');
                }
                break;
            case 'sender_disconnected':
                 isSenderConnected = false;
                 pairingSection.style.display = 'block'; // Optionally show QR again
                 imageDisplaySection.style.display = 'block'; // Keep images visible
                 imageTimerDisplay.style.display = 'block'; // Keep timer visible
                 updateStatus('Sender disconnected. Session active until timeout.', true);
                 updateImageStatus('Sender disconnected. Session will expire unless they reconnect.');
                 // Keep polling, sender might reconnect (if server allows)
                 break;
            case 'expired': // Should be caught by 404, but handle defensively
                 console.warn("Received 'expired' status during poll. Stopping.");
                 updateStatus("Session expired.", true);
                 clearInterval(statusPollIntervalId);
                 stopVisualTimer();
                 break;
            default:
                console.warn("Unknown session status received:", data.sessionStatus);
                updateStatus(`Unknown session state: ${data.sessionStatus}`, true);
        }

        // Process new images if any
        if (data.newImageIds && data.newImageIds.length > 0) {
            updateStatus('New images received by server! Fetching...');
            console.log("New image IDs received:", data.newImageIds);
            for (const imageId of data.newImageIds) {
                 // Fetch images sequentially or in parallel? Sequential might be safer.
                 await fetchAndDisplayImage(currentSessionId, imageId);
            }
             // Update status after fetching all new images in this batch
             if (isSenderConnected) {
                 updateStatus('Idle. Waiting for next image...');
                 updateImageStatus('Ready to receive images.');
             } else {
                  updateStatus('Sender disconnected. Waiting for sender or timeout...');
                  updateImageStatus('Sender disconnected.');
             }

        }
      
        console.log("Photocount:",data.photoCount);
        if(data.photoCount) {
          photoCounter.innerHTML = data.photoCount;
        }

    } catch (error) {
        console.error('Status poll failed:', error);
        updateStatus(`Error checking session status: ${error.message}. Retrying...`, true);
        // Continue polling, maybe with backoff later if needed
    }
}

function startStatusPolling() {
    clearInterval(statusPollIntervalId); // Clear existing poll if any
    if (currentSessionId && pollingIntervalMs > 0) {
        console.log(`Starting status polling every ${pollingIntervalMs}ms for session ${currentSessionId}`);
        // Run immediately first time
        pollSessionStatus();
        statusPollIntervalId = setInterval(pollSessionStatus, pollingIntervalMs);
    } else {
        console.error("Cannot start polling without session ID or valid interval.");
    }
}


// 3. Fetch and Display Image (mostly unchanged, just called differently)
async function fetchAndDisplayImage(sessionId, imageId) {
    console.log(`[fetchImage] Starting for session: ${sessionId}, imageId: ${imageId}`);
    updateImageStatus(`Downloading image: ${imageId}...`);

    let response;
    let objectURL = null;

    try {
        const cacheBuster = Date.now();
        const imageUrl = `/image/${sessionId}/${imageId}?_cb=${cacheBuster}`;
        console.log(`[fetchImage] Fetching URL: ${imageUrl}`);

        response = await fetch(imageUrl);
        console.log(`[fetchImage] Response received for ${imageId}. Status: ${response.status}, OK: ${response.ok}`);

        if (!response.ok) {
            let errorMsg = response.statusText;
            try {
                 const errorData = await response.json();
                 errorMsg = errorData.message || errorMsg;
            } catch (e) { /* Ignore if response is not JSON */ }
            throw new Error(`Fetch failed for ${imageId}: ${response.status} ${errorMsg}`);
        }

        const imageBlob = await response.blob();
        console.log(`[fetchImage] Blob received for ${imageId}. Size: ${imageBlob.size}, Type: ${imageBlob.type}`);

        if (imageBlob.size === 0) {
             throw new Error(`Received empty image blob (size 0) for ${imageId}.`);
        }

        objectURL = URL.createObjectURL(imageBlob);
        console.log(`[fetchImage] Created Object URL for ${imageId}`);

        const imageContainer = document.createElement('div');
        imageContainer.classList.add('image-container');
        imageContainer.id = `image-${imageId}`;

        const imgElement = document.createElement('img');
        const filenameElement = document.createElement('p');
        filenameElement.classList.add('image-filename');
        // Extract original filename part if possible, fallback to imageId
        const originalFilename = imageId.substring(imageId.indexOf('-') + 1);
        filenameElement.textContent = originalFilename || imageId;

        let imageLoaded = false;

        imgElement.onload = () => {
            imageLoaded = true;
            imgElement.onerror = null;
            console.log(`[fetchImage] <img> onload event fired for ${imageId}.`);
            // updateImageStatus(`Image ${originalFilename || imageId} loaded & saved.`);
            // statusDiv.textContent = 'Idle. Waiting for next image...'; // Status updated after batch in polling

            // === START: Conditional Auto-Download ===
            // we loose the image now if not saved immediately... I fixed that before....
            if (autoDownloadCheckbox.checked) {
              
                try {
                    // Use FileSaver.js - directly use the blob
                    saveAs(imageBlob, originalFilename); // Use the original blob here

                    console.log(`[fetchImage] Auto-download triggered via FileSaver.js for ${originalFilename}`);
                    updateImageStatus(`Image ${originalFilename} loaded & auto-saved.`);

                    // The objectURL is still needed for the <img> display.
                    // Don't revoke it immediately. The existing logic for revoking
                    // (or not revoking if auto-download is off) still applies
                    // to the displayed image's source. FileSaver doesn't need the objectURL.

                    // Optional: You might still want a small delay before potential revocation
                    // if you implement stricter URL management later, but FileSaver itself
                    // doesn't require the URL to stay alive after saveAs is called.


                } catch (downloadError) {
                    console.error(`[fetchImage] Error triggering auto-download via FileSaver.js for ${originalFilename}:`, downloadError);
                    updateImageStatus(`Error auto-saving ${originalFilename}. See console.`, true);
                    // Revoke URL on download error
                    if (objectURL) {
                        console.log(`[fetchImage] Revoking Object URL for ${originalFilename} after FileSaver error.`);
                        URL.revokeObjectURL(objectURL);
                        objectURL = null;
                    }
                }
              
                /*              
                try {
                    const downloadLink = document.createElement('a');
                    downloadLink.href = objectURL;
                    downloadLink.download = originalFilename; // Use extracted filename
                    document.body.appendChild(downloadLink);
                    downloadLink.click();
                    document.body.removeChild(downloadLink);
                    console.log(`[fetchImage] Auto-download triggered for ${originalFilename}`);
                    updateImageStatus(`Image ${originalFilename} loaded & auto-saved.`);

                    // Revoke URL shortly after download is initiated
                     setTimeout(() => {
                         if (objectURL) {
                             // If we revoke it we can't save it later so skip it
                             // console.log(`[fetchImage] Revoking Object URL for ${originalFilename} after successful auto-download.`);
                             // URL.revokeObjectURL(objectURL);
                             // objectURL = null; // Prevent double revocation
                         }
                     }, 500); // Small delay

                } catch (downloadError) {
                     console.error(`[fetchImage] Error triggering auto-download for ${originalFilename}:`, downloadError);
                     updateImageStatus(`Error auto-saving ${originalFilename}. See console.`, true);
                     // Optionally revoke URL even if download fails? Yes.
                      setTimeout(() => { if (objectURL) URL.revokeObjectURL(objectURL); objectURL = null; }, 100);
                }
                */
              
            } else {
                 console.log(`[fetchImage] Auto-download disabled. Skipping download for ${originalFilename}.`);
                 updateImageStatus(`Image ${originalFilename} loaded (auto-save OFF).`);
                 // Keep the objectURL alive longer so user can potentially right-click save
                 // Don't revoke immediately if not auto-downloading.
                 // Consider revoking much later or when session ends/new image arrives?
                 // For simplicity, let's just not revoke here if auto-download is off.
                 // It will be revoked naturally when the page unloads or can be managed more actively if needed.
            }
            // === END: Conditional Auto-Download ===
        };

        imgElement.onerror = (err) => {
             imageLoaded = true;
             console.error(`[fetchImage] <img> onerror event fired for ${imageId}. Failed loading Object URL.`, err);
             updateImageStatus(`Error displaying image ${imageId}.`, true);
             imgElement.alt = `Error loading ${imageId}`;
             if (objectURL) {
                console.log(`[fetchImage] Revoking Object URL for ${imageId} after load error`);
                URL.revokeObjectURL(objectURL);
                objectURL = null;
             }
        };

        imgElement.src = objectURL;
        imgElement.alt = `Received image ${originalFilename || imageId}`;

        imageContainer.appendChild(imgElement);
        imageContainer.appendChild(filenameElement);
        receivedImagesContainer.prepend(imageContainer); // Add to top

        updateImageStatus(`Rendering image ${originalFilename || imageId}...`);

        // Sanity check timeout
        setTimeout(() => {
            if (!imageLoaded && document.getElementById(imageContainer.id)) {
                 console.warn(`[fetchImage] Timeout check: Neither onload nor onerror fired for ${imageId}.`);
                 updateImageStatus(`Image ${imageId} may not have loaded correctly.`, true);
                 if (objectURL) URL.revokeObjectURL(objectURL);
            }
        }, 5000);

    } catch (error) {
        console.error(`[fetchImage] Error during fetch/processing for ${imageId}:`, error);
        // statusDiv.textContent = `Error loading image ${imageId}: ${error.message}`; // Update main status?
        // statusDiv.classList.add('error');
        updateImageStatus(`Failed to load ${imageId}. ${error.message}`, true);
         if (objectURL) {
            console.log(`[fetchImage] Revoking Object URL for ${imageId} in catch block`);
            URL.revokeObjectURL(objectURL);
         }
    }
}

// --- Initial execution ---
loadAutoDownloadPreference(); // Load preference first
resetUIForNewSession();
requestNewSession(); // Start the process on page load