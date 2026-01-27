const fs = require('fs');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');

const { getZohoAccessToken, getZohoCrmBase, clearZohoAccessToken } = require('./zoho');
const { getRecordingUrlFromFallback } = require('./recording');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function processAudioRequest(requestBody, requestId) {
    console.log(`🔧 Processing audio request ${requestId}`);
    let tempFilePath = null;
    const startTime = Date.now();
    const tempDir = path.join(__dirname, '..', 'temp');

    try {
        let requestData = null;

        console.log(`🔍 [${requestId}] Raw request body:`, requestBody);
        console.log(`🔍 [${requestId}] Body type:`, typeof requestBody);
        console.log(`🔍 [${requestId}] Body keys:`, requestBody ? Object.keys(requestBody) : 'null');

        if (requestBody && typeof requestBody === 'object') {
            if (requestBody.Call_Record_ID) {
                requestData = requestBody;
                console.log(`✅ [${requestId}] Found form-data format with Call_Record_ID` + (requestBody.Call_Recording_URL ? ' and Call_Recording_URL' : ' (will use fallback for URL)'));
            } else {
                const possibleKeys = ['Call_Record_ID', 'Call_Recording_URL', 'call_record_id', 'call_recording_url', 'recordId', 'recordingUrl'];
                let foundData = {};
                for (const key of possibleKeys) {
                    if (requestBody[key]) foundData[key] = requestBody[key];
                }
                requestData = Object.keys(foundData).length ? foundData : requestBody;
                if (Object.keys(foundData).length) console.log(`✅ [${requestId}] Found data with alternative keys:`, foundData);
                else console.log(`⚠️ [${requestId}] Using raw request body as-is:`, requestBody);
            }
        } else if (typeof requestBody === 'string') {
            try {
                requestData = JSON.parse(requestBody);
                console.log(`✅ [${requestId}] Parsed JSON from string body`);
            } catch {
                try {
                    requestData = require('querystring').parse(requestBody);
                    console.log(`✅ [${requestId}] Parsed as URL-encoded data`);
                } catch {
                    requestData = null;
                }
            }
        }

        if (!requestData) throw new Error(`Unable to parse request body. Body type: ${typeof requestBody}`);

        const Call_Record_ID = requestData.Call_Record_ID || requestData.call_record_id || requestData.recordId;
        const Call_Recording_URL = requestData.Call_Recording_URL || requestData.call_recording_url || requestData.recordingUrl;

        console.log(`🎯 [${requestId}] Processing ID: ${Call_Record_ID} with URL: ${Call_Recording_URL || 'MISSING'}`);
        if (!Call_Record_ID) throw new Error(`Missing required field: Call_Record_ID. Received: ${JSON.stringify(requestData)}`);

        // Determine recording URL: use provided URL, or fetch from Voice_Recording__s field
        let recordingUrl = Call_Recording_URL;
        if (!recordingUrl || String(recordingUrl).trim() === '') {
            console.log(`⚠️ [${requestId}] Call_Recording_URL not provided. Fetching from Voice_Recording__s field...`);
            recordingUrl = await getRecordingUrlFromFallback(Call_Record_ID, requestId);
            console.log(`✅ [${requestId}] Successfully obtained recording URL from Voice_Recording__s: ${recordingUrl}`);
        } else {
            console.log(`✅ [${requestId}] Using provided Call_Recording_URL: ${recordingUrl}`);
        }

        console.log(`📥 [${requestId}] Downloading audio file from: ${recordingUrl}`);
        const audioResponse = await axios.get(recordingUrl, { responseType: 'arraybuffer', timeout: 30000 });
        console.log(`📦 [${requestId}] Downloaded ${audioResponse.data.byteLength} bytes`);

        const contentType = audioResponse.headers['content-type'] || '';
        let fileExtension = 'mp3';
        if (contentType.includes('audio/wav') || contentType.includes('audio/wave')) fileExtension = 'wav';
        else if (contentType.includes('audio/mpeg') || contentType.includes('audio/mp3')) fileExtension = 'mp3';
        else if (contentType.includes('audio/mp4') || contentType.includes('audio/m4a')) fileExtension = 'm4a';
        else if (contentType.includes('audio/ogg')) fileExtension = 'ogg';
        else if (contentType.includes('audio/webm')) fileExtension = 'webm';
        else if (contentType.includes('audio/flac')) fileExtension = 'flac';
        else if (contentType.includes('video/mp4')) fileExtension = 'mp4';
        else {
            const urlExt = recordingUrl.toLowerCase().match(/\.(mp3|wav|m4a|ogg|webm|flac|mp4|mpeg|mpga|oga)(\?|$)/);
            if (urlExt) fileExtension = urlExt[1];
            else {
                const buffer = Buffer.from(audioResponse.data);
                if (buffer.length > 12) {
                    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') fileExtension = 'wav';
                    else if (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) fileExtension = 'mp3';
                    else if (buffer.toString('ascii', 0, 4) === 'OggS') fileExtension = 'ogg';
                    else if (buffer.toString('ascii', 4, 8) === 'ftyp') fileExtension = 'mp4';
                    else if (buffer.toString('ascii', 0, 4) === 'fLaC') fileExtension = 'flac';
                }
            }
        }

        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        tempFilePath = path.join(tempDir, `audio_${Call_Record_ID}_${Date.now()}.${fileExtension}`);
        fs.writeFileSync(tempFilePath, Buffer.from(audioResponse.data));
        console.log(`Audio saved temporarily to: ${tempFilePath}`);

        // Always translate to English (auto-detects source language and translates)
        console.log(`🌐 [${requestId}] Transcribing and translating to English (auto-detecting source language)...`);
        const translation = await openai.audio.translations.create({
            model: 'whisper-1',
            file: fs.createReadStream(tempFilePath)
        });
        const transcriptText = translation.text;
        console.log(`📝 [${requestId}] Transcription and translation successful. Length: ${transcriptText.length} characters`);
        
        // Validate transcript is not empty
        if (!transcriptText || transcriptText.trim().length === 0) {
            throw new Error('Transcription resulted in empty text. Cannot update Zoho CRM.');
        }
        console.log(`📄 [${requestId}] Transcript preview (first 200 chars): ${transcriptText.substring(0, 200)}...`);

        const accessToken = await getZohoAccessToken();
        const analysisEnabled = (process.env.ANALYSIS_ENABLED || 'true').toLowerCase() === 'true';
        const analysisModel = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-4o-mini';

        let analysisText = null;
        if (analysisEnabled) {
            try {
                const maxTranscriptChars = Number(process.env.ANALYSIS_MAX_CHARS || 16000);
                const transcriptForAnalysis = (transcriptText || '').slice(0, maxTranscriptChars);
                const prompt = `You are a sales call analyst. Summarize the call and extract key insights for a sales team in a compact, readable block. Keep it under 1200 characters. Use exactly this format and plain text only:\n\nSummary: <2–4 sentence recap>\nCustomer Sentiment: <Negative|Neutral|Positive>\nAgent Sentiment: <Negative|Neutral|Positive>\nKey Topics: <comma-separated>\nObjections: <short list>\nNext Steps: <bulleted or comma-separated>\nOutcome: <No Decision|Follow-up Needed|Qualified|Unqualified|Closed Won|Closed Lost>\nNotes: <optional short notes>\n\nTranscript:\n"""${transcriptForAnalysis}"""`;

                const completion = await openai.chat.completions.create({
                    model: analysisModel,
                    messages: [
                        { role: 'system', content: 'Return concise, sales-ready analysis as plain text. Do not include JSON. Follow the requested headings exactly.' },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.3,
                    max_tokens: 600,
                });
                analysisText = (completion.choices?.[0]?.message?.content || '').trim();
                if (analysisText && analysisText.length > 1200) analysisText = analysisText.slice(0, 1190) + '…';
            } catch (e) {
                console.warn('Analysis generation failed. Proceeding without AI_Analysis field.', e.message);
            }
        }

        const moduleApiName = 'Calls';
        // Zoho CRM API requires 'id' field in the payload for updates
        const basePayload = { 
            data: [{ 
                id: Call_Record_ID,
                Description: transcriptText 
            }] 
        };
        if (analysisText) basePayload.data[0].AI_Analysis = analysisText;

        const crmBase = getZohoCrmBase();
        const zohoUpdateUrl = `${crmBase}/${moduleApiName}/${Call_Record_ID}`;
        console.log(`📤 [${requestId}] Updating Zoho CRM record ${Call_Record_ID}...`);
        console.log(`📤 [${requestId}] Zoho URL: ${zohoUpdateUrl}`);
        console.log(`📤 [${requestId}] Payload: Description length=${transcriptText.length} chars${analysisText ? `, AI_Analysis length=${analysisText.length} chars` : ''}`);
        
        // Helper function to parse error response (handles Buffer responses)
        const parseErrorData = (errorData) => {
            if (Buffer.isBuffer(errorData)) {
                try {
                    return JSON.parse(errorData.toString());
                } catch {
                    return { raw: errorData.toString() };
                }
            }
            if (typeof errorData === 'string') {
                try {
                    return JSON.parse(errorData);
                } catch {
                    return { message: errorData };
                }
            }
            return errorData || {};
        };
        
        // Helper function to check if error is authentication failure
        const isAuthError = (errorData) => {
            const parsed = parseErrorData(errorData);
            const errorStr = JSON.stringify(parsed).toLowerCase();
            return errorStr.includes('authentication') || 
                   errorStr.includes('auth_failure') ||
                   parsed.code === 'AUTHENTICATION_FAILURE';
        };
        
        let zohoResponse;
        let retryCount = 0;
        const maxRetries = 2;
        
        while (retryCount <= maxRetries) {
            try {
                // Get fresh token if this is a retry after auth failure
                if (retryCount > 0) {
                    console.log(`🔄 [${requestId}] Retry attempt ${retryCount}: Getting fresh access token...`);
                    accessToken = await getZohoAccessToken(true);
                }
                
                zohoResponse = await axios.put(
                    zohoUpdateUrl,
                    basePayload,
                    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' } }
                );
                console.log(`📥 [${requestId}] Zoho API Response Status: ${zohoResponse.status}`);
                console.log(`📥 [${requestId}] Zoho API Response:`, JSON.stringify(zohoResponse.data, null, 2));
                break; // Success, exit retry loop
            } catch (zErr) {
                const errorData = zErr.response?.data;
                const parsedError = parseErrorData(errorData);
                
                console.error(`❌ [${requestId}] Zoho update failed:`, zErr.message);
                if (zErr.response) {
                    console.error(`❌ [${requestId}] Zoho Error Status: ${zErr.response.status}`);
                    console.error(`❌ [${requestId}] Zoho Error Data:`, JSON.stringify(parsedError, null, 2));
                }
                
                // Check if it's an authentication error
                if (isAuthError(errorData) && retryCount < maxRetries) {
                    console.warn(`⚠️ [${requestId}] Authentication failure detected. Clearing token cache and retrying...`);
                    clearZohoAccessToken();
                    retryCount++;
                    continue; // Retry with fresh token
                }
                
                // Check if it's an AI_Analysis field error
                const isFieldError = JSON.stringify(parsedError).toLowerCase().includes('ai_analysis');
                if (analysisText && isFieldError && retryCount === 0) {
                    console.warn(`⚠️ [${requestId}] Zoho rejected AI_Analysis field. Retrying with Description only...`);
                    basePayload.data[0] = { id: Call_Record_ID, Description: transcriptText };
                    delete basePayload.data[0].AI_Analysis;
                    retryCount++;
                    continue; // Retry without AI_Analysis
                }
                
                // If we get here, it's not a retryable error or we've exhausted retries
                throw zErr;
            }
        }

        // Verify the update was successful
        if (zohoResponse && zohoResponse.data) {
            const updateResult = zohoResponse.data.data?.[0];
            if (updateResult) {
                console.log(`✅ [${requestId}] Zoho CRM updated successfully! Record ID: ${updateResult.id || Call_Record_ID}`);
            } else {
                console.warn(`⚠️ [${requestId}] Zoho response missing data field. Full response:`, JSON.stringify(zohoResponse.data, null, 2));
            }
        } else {
            console.warn(`⚠️ [${requestId}] Zoho response structure unexpected:`, zohoResponse);
        }
        return {
            message: 'Audio transcribed and CRM updated successfully.',
            recordId: Call_Record_ID,
            transcript: transcriptText,
            requestId,
            processingTime: Date.now() - startTime,
        };
    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        // Helper to parse error data (handles Buffer, string, or object)
        const parseErrorData = (errorData) => {
            if (Buffer.isBuffer(errorData)) {
                try {
                    return JSON.parse(errorData.toString());
                } catch {
                    return { raw: errorData.toString() };
                }
            }
            if (typeof errorData === 'string') {
                try {
                    return JSON.parse(errorData);
                } catch {
                    return { message: errorData };
                }
            }
            return errorData || {};
        };
        
        if (error.response) {
            const parsedData = parseErrorData(error.response.data);
            console.error(`💥 [${requestId}] API Error (${error.response.status}):`, { 
                url: error.config?.url, 
                status: error.response.status, 
                data: parsedData 
            });
        } else if (error.request) {
            console.error(`💥 [${requestId}] Network Error (no response):`, { url: error.config?.url });
        }
        console.error(`💥 [${requestId}] Error after ${processingTime}ms:`, error.message);

        let errorMessage = error.message;
        if (error.response) {
            const url = error.config?.url || '';
            const apiName = url.includes('zohoapis.com') ? 'Zoho' : url.includes('knowlarity.com') ? 'Knowlarity' : url.includes('openai.com') ? 'OpenAI' : 'API';
            errorMessage = `${apiName} API request failed: ${error.message}`;
            
            const parsedData = parseErrorData(error.response.data);
            if (parsedData) {
                const errorStr = typeof parsedData === 'string' ? parsedData : JSON.stringify(parsedData);
                errorMessage += ` - ${errorStr.slice(0, 200)}`;
            }
        }
        const enhancedError = new Error(errorMessage);
        enhancedError.originalError = error;
        enhancedError.response = error.response;
        throw enhancedError;
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                console.log(`🧹 [${requestId}] Temporary file cleaned up: ${tempFilePath}`);
            } catch (e) {
                console.error(`❌ [${requestId}] Failed to clean up temporary file:`, e.message);
            }
        }
    }
}

module.exports = { processAudioRequest };
