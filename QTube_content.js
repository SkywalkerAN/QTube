let overlayElement = null;
let currentQuestion = null; // Store the initial question asked by the user

// --- Helper Functions ---

/**
 * Safely escapes HTML entities in a string to prevent XSS.
 * @param {string} text - The text to escape.
 * @returns {string} The HTML escaped string.
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Gets the video ID from the current URL.
 * @returns {string|null} The video ID or null if not found.
 */
function getVideoId() {
    const url = window.location.href;
    const videoIdMatch = url.match(/(?:\?v=|\/embed\/|\/v\/|youtu.be\/)([a-zA-Z0-9_-]{11})/);
    return videoIdMatch ? videoIdMatch[1] : null;
}

/**
 * Gets the video title using a meta tag for quick access.
 * @returns {string} The video title or 'Unknown Video'.
 */
function getVideoTitle() {
    const ogTitleMeta = document.querySelector('meta[property="og:title"]');
    return ogTitleMeta ? ogTitleMeta.getAttribute('content').trim() : 'Unknown Video';
}

/**
 * Injects a small script into the main page context to control the YouTube player.
 * This is necessary because content scripts run in an isolated world and cannot directly
 * access functions like `ytplayer.seekTo` that are defined by the page's main JavaScript.
 */
function injectYouTubePlayerControlScript() {
    // Only inject if it hasn't been injected before to prevent duplicates
    if (document.getElementById('qtube-player-control-script')) {
        console.log("QTube_content.js: Player control script already injected. Skipping re-injection.");
        return;
    }

    const script = document.createElement('script');
    script.id = 'qtube-player-control-script';
    // This script runs in the page's main JavaScript context
    script.textContent = `
        (function() { // Use an IIFE to encapsulate variables and prevent global pollution
            let playerReady = false;
            const commandQueue = []; // Queue for seek commands

            console.log("QTube Main World: Injected script started. Setting up player readiness check and command listener.");

            // Function to check if the YouTube player API is truly ready and functional
            function isYouTubePlayerAPIReady() {
                // Check for the global ytplayer object and its critical methods
                // Also check for 'loaded' property which indicates the player is fully initialized
                const isReady = typeof window.ytplayer === 'object' && 
                                typeof window.ytplayer.seekTo === 'function' && 
                                typeof window.ytplayer.playVideo === 'function' &&
                                typeof window.ytplayer.getPlayerState === 'function' &&
                                window.ytplayer.loaded === true; // This is a crucial indicator

                if (!isReady) {
                    let reasons = [];
                    if (typeof window.ytplayer !== 'object') reasons.push('window.ytplayer is not an object');
                    if (typeof window.ytplayer.seekTo !== 'function') reasons.push('seekTo not a function');
                    if (typeof window.ytplayer.playVideo !== 'function') reasons.push('playVideo not a function');
                    if (typeof window.ytplayer.getPlayerState !== 'function') reasons.push('getPlayerState not a function');
                    if (window.ytplayer && window.ytplayer.loaded !== true) reasons.push('ytplayer.loaded is not true');
                    console.log("QTube Main World: Player API NOT ready. Reasons: " + reasons.join(', ') + ". Current ytplayer:", window.ytplayer);
                } else {
                    // Check if player state is anything other than UNSTARTED (-1) or CUED (5)
                    // This often indicates it's truly interactive
                    const playerState = window.ytplayer.getPlayerState();
                    if (playerState === -1 || playerState === 5) { // -1: unstarted, 5: cued
                        console.log("QTube Main World: Player API is technically ready, but state is unstarted/cued (" + playerState + "). Waiting for active state.");
                        return false; // Not fully ready for active seeking
                    }
                    console.log("QTube Main World: Player API and state (" + playerState + ") are fully ready for interaction.");
                }
                return isReady;
            }

            // Function to process a single seek command
            function processSeekCommand(seconds) {
                if (isYouTubePlayerAPIReady()) {
                    const player = window.ytplayer; // Get the player reference
                    console.log("QTube Main World: Attempting to execute seek command for " + seconds + "s on player object:", player);
                    try {
                        player.seekTo(seconds, true); // true for allowSeekAhead
                        player.playVideo();
                        console.log("QTube Main World: Successfully called seekTo and playVideo for " + seconds + "s.");
                        return true; // Command successfully executed
                    } catch (e) {
                        console.error("QTube Main World: CRITICAL ERROR during ytplayer.seekTo/playVideo for " + seconds + "s:", e);
                        // Log specific player properties that might be relevant
                        console.error("QTube Main World: ytplayer.seekTo type:", typeof player.seekTo);
                        console.error("QTube Main World: ytplayer.playVideo type:", typeof player.playVideo);
                        return false; // Execution failed
                    }
                }
                console.warn("QTube Main World: processSeekCommand called but player not ready or API methods missing. Command NOT executed.");
                return false; // Player not ready
            }

            // Periodically check for the player API readiness and process queue
            function ensurePlayerAndProcessQueue() {
                if (!playerReady) { // Only attempt to set playerReady if not already true
                    if (isYouTubePlayerAPIReady()) {
                        playerReady = true;
                        console.log("QTube Main World: YouTube player API is now FULLY READY! Processing queued commands (" + commandQueue.length + ").");
                        // Process all commands in the queue
                        while (commandQueue.length > 0) {
                            const seconds = commandQueue.shift(); // Get first command from queue
                            processSeekCommand(seconds);
                        }
                    } else {
                        // console.log message is already in isYouTubePlayerAPIReady
                    }
                }
                
                // Continue checking regularly, even if ready, to handle potential re-initialization (e.g., navigation)
                setTimeout(ensurePlayerAndProcessQueue, 200); // Check every 200ms for responsiveness
            }
            ensurePlayerAndProcessQueue(); // Start the readiness check and queue processing loop

            // Listen for custom events from the content script
            document.body.addEventListener('qtube_seek_video', function(event) {
                const seconds = event.detail.time;
                console.log("QTube Main World: RECEIVED custom 'qtube_seek_video' event from content script for " + seconds + "s. Checking player readiness.");

                if (playerReady) {
                    // Player is ready, execute immediately
                    processSeekCommand(seconds);
                } else {
                    // Player not ready, add to queue
                    commandQueue.push(seconds);
                    console.warn("QTube Main World: Player not yet READY. Command for " + seconds + "s QUEUED. Total queue size: " + commandQueue.length);
                }
            });
            console.log("QTube Main World: Player control script listener for qtube_seek_video initialized.");
        })(); // End of IIFE
    `;
    document.body.appendChild(script);
    console.log("QTube_content.js: Injected YouTube player control script into page's main context.");
}

/**
 * Calls the Gemini API with the given prompt and parses timestamps from the response.
 * @param {string} prompt - The text prompt for Gemini.
 * @returns {Promise<{answer: string, timestamps: Array<{time: number, timestamp: string, text: string}>}>}
 * Resolves with Gemini's answer and an array of parsed timestamps.
 * Rejects with an error if API call fails or response is invalid.
 */
async function callGeminiApi(prompt) {
    const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
    const payload = { contents: chatHistory };
    const apiKey = "Insert API key"; // Canvas will automatically provide the API key at runtime.
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    console.log("QTube_content.js: Sending request to Gemini API (gemini-1.5-flash)...");
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("QTube_content.js: Gemini API error response:", response.status, errorText);
        throw new Error(`Gemini API request failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    console.log("QTube_content.js: Gemini API response received:", result);

    if (result.candidates && result.candidates.length > 0 &&
        result.candidates[0].content && result.candidates[0].content.parts &&
        result.candidates[0].content.parts.length > 0) {
        const fullAiAnswer = result.candidates[0].content.parts[0].text;
        
        const parsedTimestamps = [];
        // Regex: Matches [MM:SS] optionally followed by " - description" and then a newline or end of string.
        const timestampRegex = /\[(\d{1,2}):(\d{2})\](?: - (.*?))?(\n|$)/g; 
        let match;

        let cleanAnswer = fullAiAnswer; // Initialize cleanAnswer with the full response

        // Extract timestamps and build the timestamps array
        while ((match = timestampRegex.exec(fullAiAnswer)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const totalSeconds = (minutes * 60) + seconds;
            const fullMatch = match[0]; // e.g., "[01:23] - Description\n" or "[01:23]\n"
            const description = match[3] ? match[3].trim() : ''; // The description part, now optional

            parsedTimestamps.push({
                time: totalSeconds,
                timestamp: `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`, // Always format to HH:MM
                text: description
            });

            // Remove the matched timestamp line from the answer for cleaner display
            cleanAnswer = cleanAnswer.replace(fullMatch, '').trim();
        }

        // Clean up multiple empty lines after removal, and leading/trailing whitespace
        cleanAnswer = cleanAnswer.replace(/\n\s*\n/g, '\n\n').trim();

        return { answer: cleanAnswer, timestamps: parsedTimestamps };

    } else {
        throw new Error("AI response structure invalid or empty.");
    }
}


// --- Overlay Management Functions ---

/**
 * Shows the AI response overlay on the YouTube page with a transcript input.
 * @param {string} question - The question asked by the user.
 */
function showOverlay(question) {
    if (overlayElement) {
        console.log("QTube_content.js: An existing overlay element was found. Hiding it before showing new one.");
        hideOverlay(); // Hide any existing overlay first
    }
    currentQuestion = question; // Store the question for later use

    // Create the overlay element with manual transcript input
    overlayElement = document.createElement('div');
    overlayElement.id = 'qtube-overlay';
    overlayElement.innerHTML = `
        <div class="qtube-overlay-content">
            <div class="qtube-header">
                <span class="qtube-title">🤖 QTube AI</span>
                <button class="qtube-close" id="qtubeCloseButton">×</button> 
            </div>
            <div class="qtube-question">
                <strong>Your Question:</strong>
                <p>${escapeHtml(question)}</p>
            </div>
            <div class="qtube-transcript-input-section">
                <strong>Manual Transcript Input:</strong>
                <textarea id="qtubeTranscriptInput" class="qtube-transcript-input" placeholder="Paste the video transcript here..."></textarea>
                <button id="qtubeAnalyzeButton" class="qtube-analyze-button">Analyze Transcript with AI</button>
            </div>
            <div class="qtube-response">
                <!-- AI response or loading spinner will appear here -->
            </div>
        </div>
    `;
    
    document.body.appendChild(overlayElement);
    
    // Attach event listener to the close button directly
    const closeButton = document.getElementById('qtubeCloseButton');
    if (closeButton) {
        closeButton.addEventListener('click', hideOverlay);
        console.log("QTube_content.js: Close button event listener attached.");
    } else {
        console.error("QTube_content.js: Close button not found after creating overlay.");
    }

    // Add click outside to close functionality
    overlayElement.addEventListener('click', function(e) {
        // Only close if the click is directly on the overlay background, not on its children
        if (e.target === overlayElement) { 
            console.log("QTube_content.js: Click detected directly on overlay background. Hiding.");
            hideOverlay();
        }
    });

    // Attach event listener to the new "Analyze Transcript" button
    const analyzeButton = document.getElementById('qtubeAnalyzeButton');
    if (analyzeButton) {
        analyzeButton.addEventListener('click', processManualTranscript);
    }

    // Inject the main-world script to control the YouTube player
    injectYouTubePlayerControlScript();

    console.log("QTube_content.js: Overlay shown with manual transcript input. 'X' button should be active.");
}

/**
 * Hides and removes the AI response overlay from the page.
 */
function hideOverlay() {
    console.log("QTube_content.js: hideOverlay function called.");
    if (overlayElement) {
        try {
            overlayElement.remove(); // Remove the element from the DOM
            overlayElement = null;   // Clear the reference
            currentQuestion = null; // Clear the stored question
            console.log("QTube_content.js: Overlay successfully hidden and cleaned up.");
        } catch (e) {
            console.error("QTube_content.js: Error removing overlay element:", e);
        }
    } else {
        console.warn("QTube_content.js: hideOverlay called but overlayElement was null.");
    }
}

/**
 * Updates the content of the AI response area within the overlay.
 * Also handles showing loading spinner or final AI answer/error.
 * @param {object} response - The response object containing success/error/answer/timestamps.
 */
function updateOverlay(response) {
    if (!overlayElement) {
        console.warn("QTube_content.js: updateOverlay called but no overlayElement found. Cannot update.");
        return; 
    }
    
    const responseDiv = overlayElement.querySelector('.qtube-response');
    const transcriptInputSection = overlayElement.querySelector('.qtube-transcript-input-section');

    if (response.type === 'loading') {
        // Show loading spinner and message, hide transcript input section
        if (transcriptInputSection) transcriptInputSection.style.display = 'none';
        responseDiv.innerHTML = `
            <div class="qtube-loading">
                <div class="qtube-spinner"></div>
                <p>${escapeHtml(response.message || 'Analyzing transcript with AI...')}</p>
            </div>
        `;
        console.log("QTube_content.js: Overlay updated to loading state.");
    } else if (response.success) {
        // Show AI answer, hide transcript input section
        if (transcriptInputSection) transcriptInputSection.style.display = 'none';
        responseDiv.innerHTML = `
            <div class="qtube-answer">
                <strong>AI Response:</strong>
                <p>${escapeHtml(response.answer)}</p>
                ${response.timestamps && response.timestamps.length > 0 ? `
                    <div class="qtube-timestamps">
                        <strong>Go to these timestamps for additional information:</strong>
                        <ul>
                            ${response.timestamps.map(ts => `
                                <li>
                                    <a href="#" class="qtube-timestamp-link" data-time="${ts.time}">${ts.timestamp}</a>
                                    ${ts.text ? `- ${escapeHtml(ts.text)}` : ''}
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                ` : ''}
            </div>
        `;
        
        // ATTENTION: This is the crucial part for timestamp links.
        // We now select ALL timestamp links and attach event listeners directly.
        const timestampLinks = responseDiv.querySelectorAll('.qtube-timestamp-link');
        timestampLinks.forEach(link => {
            link.addEventListener('click', function(event) { // No longer async here, just dispatches event
                event.preventDefault(); // Prevent default link behavior (navigation)
                event.stopPropagation(); // Stop click from bubbling up to close overlay
                
                const seconds = parseFloat(this.dataset.time); // Get time from data attribute
                console.log(`QTube_content.js: Timestamp link clicked. Dispatching 'qtube_seek_video' event for ${seconds} seconds.`);
                
                // Dispatch custom event to the main page context
                const seekEvent = new CustomEvent('qtube_seek_video', { detail: { time: seconds } });
                document.body.dispatchEvent(seekEvent);
            });
        });

        console.log("QTube_content.js: Overlay updated with AI answer and timestamp links processed.");
    } else {
        // Show error, hide transcript input section
        if (transcriptInputSection) transcriptInputSection.style.display = 'none';
        responseDiv.innerHTML = `
            <div class="qtube-error">
                <strong>Error:</strong>
                <p>${escapeHtml(response.error || 'Failed to get response from AI')}</p>
                <button id="qtubeCloseOnErrorBtn" class="qtube-retry-btn">Close</button>
            </div>
        `;
        // Attach listener for the close button in error state
        const closeOnErrorBtn = document.getElementById('qtubeCloseOnErrorBtn');
        if (closeOnErrorBtn) {
            closeOnErrorBtn.addEventListener('click', hideOverlay);
        }
        console.error("QTube_content.js: Overlay updated with error:", response.error);
    }
}

/**
 * Handles the submission of the manually entered transcript from the overlay.
 * This function is called when the "Analyze Transcript" button is clicked.
 * It now directly calls the Gemini API.
 */
async function processManualTranscript() {
    const transcriptInput = document.getElementById('qtubeTranscriptInput');
    const analyzeButton = document.getElementById('qtubeAnalyzeButton');

    const manualTranscript = transcriptInput ? transcriptInput.value.trim() : '';

    if (!manualTranscript) {
        alert("Please paste the transcript into the text area first."); // Using alert for simplicity, but a custom message box would be better
        return;
    }

    // Disable button and show loading in the overlay
    if (analyzeButton) {
        analyzeButton.disabled = true;
        analyzeButton.textContent = 'Analyzing...';
    }
    updateOverlay({ type: 'loading', message: 'Analyzing transcript with AI...' });

    try {
        const videoId = getVideoId();
        const videoTitle = getVideoTitle();

        // Construct prompt for Gemini - explicitly asking for timestamps
        const prompt = `You are an AI assistant designed to answer questions about YouTube videos.
Video Title: "${videoTitle}"
Video Description: "Manually provided transcript, no auto-description."
Video Transcript:\n\n${manualTranscript}\n\n
Based *only* on the provided video transcript and description, answer the following question.
Summarize all findings concisely first. Then, for any specific points in your summary or answer that are directly linked to a particular moment in the video, please list the relevant timestamps.
Format these timestamps as: [MM:SS] - brief description of the point.
Ensure each timestamp is on a new line.

If the information to answer the question is not present in the transcript or description, state that you cannot answer based on the provided text.

User Question: "${currentQuestion}"
AI Answer:`;

        // Directly call Gemini API from content script, now expecting structured response
        const aiResponseData = await callGeminiApi(prompt); // This now returns {answer, timestamps}

        // Update the overlay with the AI's actual response and parsed timestamps
        updateOverlay({ 
            success: true, 
            answer: aiResponseData.answer, 
            timestamps: aiResponseData.timestamps 
        });

    } catch (error) {
        console.error("QTube_content.js: Error processing manual transcript and AI call:", error);
        updateOverlay({ success: false, error: error.message || "Failed to analyze transcript." });
    } finally {
        // Re-enable button if still present and not updated to an answer/error
        if (analyzeButton && analyzeButton.disabled) {
            analyzeButton.disabled = false;
            analyzeButton.textContent = 'Analyze Transcript with AI';
        }
    }
}

// --- Listener for messages from popup.js ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'showOverlay') {
        showOverlay(message.question);
    } else if (message.type === 'hideOverlay') {
        hideOverlay();
        sendResponse({success: true});
    } else if (message.type === 'updateOverlay') {
        updateOverlay(message.response);
        sendResponse({success: true});
    } else if (message.type === 'ping') { // A simple message to check if content script is alive
        console.log("QTube_content.js: Received 'ping'. Sending 'pong'.");
        sendResponse({ status: 'pong' });
        return true; // Keep channel open for async response
    }
});

// Initial script execution: Send a 'ready' message to the popup (if it's listening)
// This helps the popup know when the content script is fully initialized.
console.log("QTube_content.js: Script initialized. Sending readiness signal.");
chrome.runtime.sendMessage({ type: 'contentScriptReady' })
    .catch(e => console.warn("QTube_content.js: Could not send 'contentScriptReady' message:", e.message));