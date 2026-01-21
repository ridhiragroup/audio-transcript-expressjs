const fs = require('fs');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');

const { getZohoAccessToken, getZohoCrmBase } = require('./zoho');
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

        let recordingUrl = Call_Recording_URL;
        if (!recordingUrl || String(recordingUrl).trim() === '') {
            console.log(`⚠️ Call_Recording_URL not provided. Using fallback flow: Zoho -> Knowlarity`);
            recordingUrl = await getRecordingUrlFromFallback(Call_Record_ID, requestId);
            console.log(`✅  Fallback flow successful. Obtained recording URL: ${recordingUrl}`);
        } else {
            console.log(`✅  Using provided Call_Recording_URL: ${recordingUrl}`);
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

        const translateRequested = Boolean(
            (requestData && (requestData.translate === true || requestData.translate === 'true' || requestData.translate === '1')) ||
            (process.env.DEFAULT_TRANSCRIBE_TRANSLATE === 'true')
        );

        let transcriptText;
        if (translateRequested) {
            console.log(`🌐 [${requestId}] Translation to English ENABLED`);
            const translation = await openai.audio.translations.create({ model: 'whisper-1', file: fs.createReadStream(tempFilePath) });
            transcriptText = translation.text;
        } else {
            const opts = { model: 'whisper-1', file: fs.createReadStream(tempFilePath) };
            if (requestData?.language) opts.language = requestData.language;
            else if (process.env.DEFAULT_TRANSCRIBE_LANGUAGE) opts.language = process.env.DEFAULT_TRANSCRIBE_LANGUAGE;
            const transcription = await openai.audio.transcriptions.create(opts);
            transcriptText = transcription.text;
        }
        console.log(`📝 [${requestId}] Transcription successful. Length: ${transcriptText.length} characters`);

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
        const basePayload = { data: [{ Description: transcriptText }] };
        if (analysisText) basePayload.data[0].AI_Analysis = analysisText;

        const crmBase = getZohoCrmBase();
        let zohoResponse;
        try {
            zohoResponse = await axios.put(
                `${crmBase}/${moduleApiName}/${Call_Record_ID}`,
                basePayload,
                { headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' } }
            );
        } catch (zErr) {
            const isFieldError = JSON.stringify(zErr.response?.data || {}).toLowerCase().includes('ai_analysis');
            if (analysisText && isFieldError) {
                console.warn('Zoho rejected AI_Analysis field. Retrying with Description only...');
                zohoResponse = await axios.put(
                    `${crmBase}/${moduleApiName}/${Call_Record_ID}`,
                    { data: [{ Description: transcriptText }] },
                    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' } }
                );
            } else throw zErr;
        }

        console.log(`✅ [${requestId}] Zoho CRM updated successfully!`);
        return {
            message: 'Audio transcribed and CRM updated successfully.',
            recordId: Call_Record_ID,
            transcript: transcriptText,
            requestId,
            processingTime: Date.now() - startTime,
        };
    } catch (error) {
        const processingTime = Date.now() - startTime;
        if (error.response) {
            console.error(`💥 [${requestId}] API Error (${error.response.status}):`, { url: error.config?.url, status: error.response.status, data: error.response.data });
        } else if (error.request) {
            console.error(`💥 [${requestId}] Network Error (no response):`, { url: error.config?.url });
        }
        console.error(`💥 [${requestId}] Error after ${processingTime}ms:`, error.message);

        let errorMessage = error.message;
        if (error.response) {
            const url = error.config?.url || '';
            const apiName = url.includes('zohoapis.com') ? 'Zoho' : url.includes('knowlarity.com') ? 'Knowlarity' : url.includes('openai.com') ? 'OpenAI' : 'API';
            errorMessage = `${apiName} API request failed: ${error.message}`;
            if (error.response.data) errorMessage += ` - ${String(typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data)).slice(0, 200)}`;
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
