const contentScriptReadyPromises = new Map();

document.addEventListener('DOMContentLoaded', function() {
    const questionInput = document.getElementById('questionInput');
    const askButton = document.getElementById('askButton');
    const popupMessage = document.getElementById('popupMessage'); 

    const defaultText = 'Ask a question about this video (under 200 characters)...';
    
    if (questionInput.value.trim() === '') {
        questionInput.value = defaultText;
        questionInput.style.color = '#999';
    }

    
    questionInput.addEventListener('focus', function() {
        if (this.value === defaultText) {
            this.value = '';
            this.style.color = '#333';
        }
    });
    
    questionInput.addEventListener('blur', function() {
        if (this.value.trim() === '') {
            this.value = defaultText;
            questionInput.style.color = '#999';
        }
    });

    questionInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { 
            e.preventDefault();
            askQuestion();
        }
    });

    
    askButton.addEventListener('click', askQuestion);

    /**
     * Displays a temporary message within the popup.
     * @param {string} message - The message text.
     * @param {string} type - 'info' or 'error' for styling.
     */
    function displayMessage(message, type = 'info') {
        popupMessage.textContent = message;
        popupMessage.className = `popup-message ${type}`; 
        popupMessage.style.display = 'block';
        setTimeout(() => {
            popupMessage.style.display = 'none';
        }, 5000); 
    }

    /**
     * Sends a message to the content script with a retry mechanism.
     * This is crucial for robustness as content script might not be immediately ready.
     * @param {number} tabId - The ID of the target tab.
     * @param {object} message - The message payload.
     * @param {number} retries - Number of retry attempts.
     * @param {number} delay - Delay between retries in ms.
     * @returns {Promise<any>} Resolves with the response from content script or rejects on failure.
     */
    async function sendMessageWithRetry(tabId, message, retries = 3, delay = 500) {
        for (let i = 0; i <= retries; i++) {
            try {
                // Clear chrome.runtime.lastError before sending to get a clean state.
                chrome.runtime.lastError; 
                const response = await chrome.tabs.sendMessage(tabId, message);
                // If response is received and no lastError, it's a success
                if (!chrome.runtime.lastError) {
                    return response; 
                }
                // If lastError exists, it indicates a connection issue or no listener
                const errorMsg = chrome.runtime.lastError.message || "Unknown connection error";
                console.warn(`Popup: Attempt ${i + 1} failed for message type '${message.action || message.type}': ${errorMsg}`);
                if (i < retries) {
                    await new Promise(resolve => setTimeout(resolve, delay)); // Wait before retry
                    continue; 
                } else {
                    throw new Error(`Failed to send message after ${retries + 1} attempts: ${errorMsg}`);
                }
            } catch (e) {
                // Catch any explicit errors thrown by sendMessage (e.g., target tab closed)
                console.warn(`Popup: Attempt ${i + 1} caught error for message type '${message.action || message.type}': ${e.message}`);
                if (i < retries && e.message.includes("Could not establish connection")) {
                    await new Promise(resolve => setTimeout(resolve, delay)); // Wait before retry
                    continue; 
                } else {
                    throw new Error(`Failed to send message after ${retries + 1} attempts: ${e.message}`);
                }
            }
        }
        // Should not reach here, but for safety
        throw new Error("sendMessageWithRetry failed without explicit error after all retries.");
    }

    /**
     * Ensures the content script is loaded and ready in the given tab.
     * If not, it injects it and waits for a 'contentScriptReady' signal.
     * @param {number} tabId - The ID of the tab.
     * @returns {Promise<void>} Resolves when the content script is ready.
     */
    async function ensureContentScriptLoaded(tabId) {
        if (contentScriptReadyPromises.has(tabId)) {
            console.log(`Popup: Content script already requested for tab ${tabId}. Awaiting existing promise.`);
            return contentScriptReadyPromises.get(tabId);
        }

        const promise = new Promise(async (resolve, reject) => {
            // Setup a one-time listener for the 'contentScriptReady' message
            const readyListener = (msg, sender, sendResponse) => {
                if (sender.tab && sender.tab.id === tabId && msg.type === 'contentScriptReady') {
                    console.log(`Popup: Received 'contentScriptReady' from tab ${tabId}. Content script is now ready.`);
                    chrome.runtime.onMessage.removeListener(readyListener); // Clean up listener
                    resolve();
                }
            };
            chrome.runtime.onMessage.addListener(readyListener);

            try {
                // First, try sending a ping to see if the content script is already active
                // This message has a quick timeout. If it fails, we inject.
                console.log(`Popup: Pinging content script in tab ${tabId}...`);
                await chrome.tabs.sendMessage(tabId, { type: 'ping' });
                // If no error was thrown and it returned, it means ping succeeded.
                console.log(`Popup: Ping successful. Content script in tab ${tabId} is already active.`);
                chrome.runtime.onMessage.removeListener(readyListener); // Remove if already active
                resolve();
                
            } catch (e) {
                console.warn(`Popup: Ping failed for tab ${tabId} (${e.message}). Proceeding to inject content script.`);
                // If ping fails (connection error or no response), inject the script
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        files: ['QTube_content.js']
                    });
                    console.log(`Popup: QTube_content.js injected into tab ${tabId}.`);

                    // The readyListener is already set up and will catch the 'contentScriptReady' signal
                    // from the newly injected script.
                    
                } catch (scriptingError) {
                    console.error(`Popup: Failed to inject content script into tab ${tabId}:`, scriptingError);
                    chrome.runtime.onMessage.removeListener(readyListener); // Clean up on scripting error
                    reject(new Error(`Failed to inject QTube_content.js: ${scriptingError.message}`));
                }
            }

            // Set a timeout to reject the promise if 'contentScriptReady' is not received after injection
            // This timeout only applies if script was injected (ping failed).
            setTimeout(() => {
                // Only reject if the promise hasn't already resolved/rejected
                // by the readyListener or ping success.
                if (promise === contentScriptReadyPromises.get(tabId)) { // Check if this is still the active promise
                    chrome.runtime.onMessage.removeListener(readyListener);
                    reject(new Error(`Content script in tab ${tabId} did not send 'contentScriptReady' signal after injection timeout.`));
                    contentScriptReadyPromises.delete(tabId); // Clean up map entry on timeout
                }
            }, 15000); // Increased timeout to 15 seconds for injection readiness
        });

        contentScriptReadyPromises.set(tabId, promise);
        return promise;
    }


    /**
     * Handles the user's question submission from the popup.
     * This function now ensures content script is ready, shows the overlay,
     * and closes the popup. Manual transcript input and AI analysis will happen
     * directly within the content script.
     */
    async function askQuestion() {
        const question = questionInput.value.trim();
        
        // Input validation
        if (!question || question === defaultText) {
            displayMessage('Please enter a question first!', 'error');
            return;
        }
        
        if (question.length > 200) {
            displayMessage('Please keep your question under 200 characters.', 'error');
            return;
        }
        
        // Show loading state and prepare for message sending
        askButton.disabled = true;
        askButton.textContent = 'Opening AI Chat...';
        displayMessage('Ensuring AI chat is ready...', 'info');

        try {
            // Get current tab details
            const tabs = await chrome.tabs.query({active: true, currentWindow: true});
            const currentTab = tabs[0];
            
            // Check if on a YouTube video page
            if (!currentTab.url.includes('youtube.com/watch')) {
                displayMessage('Please navigate to a YouTube video page first.', 'error');
                return;
            }

            // Ensure the content script is loaded and ready in the target tab
            await ensureContentScriptLoaded(currentTab.id);
            displayMessage('AI chat ready. Displaying overlay...', 'info');

            // Send message to content script to show the overlay with the question
            await sendMessageWithRetry(currentTab.id, {
                type: 'showOverlay', // Action for content.js to display overlay
                question: question
            }, 5, 750); 

            // If everything succeeded, close the popup
            window.close();
            
        } catch (error) {
            console.error('Popup: Error during initial overlay display:', error);
            const userErrorMessage = `Error: ${error.message || 'Failed to open AI chat overlay.'} Please ensure the YouTube page is fully loaded and try again.`;
            displayMessage(userErrorMessage, 'error');

        } finally {
            // Reset button state regardless of success or failure
            askButton.disabled = false;
            askButton.textContent = 'Ask AI';
            if (!document.hidden) { 
                setTimeout(() => {
                    popupMessage.style.display = 'none';
                }, 5000);
            }
        }
    }

    // NEW: Listener for messages FROM content.js (when manual transcript is submitted and AI processed)
    // The content script now directly handles the AI call after manual transcript input.
    // This listener will respond to the `processManualTranscript` message from content.js,
    // which effectively passes the AI processing task *to* the popup.
    // (This listener handles the `callGeminiApi` logic)
    chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
        if (message.type === 'processManualTranscript') {
            // Verify this message is coming from the content script in an active tab
            // (Important check since background script is removed, and popup might get messages from other tabs if not careful)
            const tabs = await chrome.tabs.query({active: true, currentWindow: true});
            const currentTab = tabs[0];
            if (!currentTab || !sender.tab || sender.tab.id !== currentTab.id) {
                console.warn("Popup: Received processManualTranscript from non-active or invalid tab. Ignoring.");
                sendResponse({ success: false, error: "Invalid tab context for AI processing." });
                return;
            }

            console.log("Popup: Received 'processManualTranscript' message from content script for AI processing.");
            try {
                // 1. Construct prompt
                const videoData = message.videoData;
                const prompt = `You are an AI assistant designed to answer questions about YouTube videos.
Video Title: "${videoData.videoTitle}"
Video Description: "${videoData.videoDescription}"
Video Transcript:\n\n${videoData.videoTranscript}\n\n
Based *only* on the provided video transcript and description, answer the following question. If the information is not present in the transcript or description, state that you cannot answer based on the provided text.
User Question: "${message.question}"
AI Answer:`;

                // 2. Call Gemini API
                const aiAnswer = await callGeminiApi(prompt);

                // 3. Send AI answer back to content script to update overlay
                sendResponse({ success: true, answer: aiAnswer });

            } catch (error) {
                console.error("Popup: Error in processManualTranscript (Gemini API call):", error);
                sendResponse({ success: false, error: error.message || "Failed to get AI response." });
            }
            return true; // Keep message channel open for async response
        }
    });

});
