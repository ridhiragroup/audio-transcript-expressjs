const { fetchZohoCallRecord } = require('./zoho');
const { extractUuid, fetchKnowlarityRecordingUrl } = require('./knowlarity');

/**
 * Get recording URL from Voice_Recording__s field.
 * Always fetches from Voice_Recording__s field and handles:
 * 1. Direct downloadable URL (http/https, NOT phonebridge) -> use it directly for transcription
 * 2. Phonebridge URL or UUID/recording path -> extract UUID and fetch secured URL from Knowlarity
 */
async function getRecordingUrlFromFallback(callRecordId, requestId) {
    console.log(`🔄 [${requestId}] Fetching Voice_Recording__s from Zoho CRM...`);

    const voiceRecording = await fetchZohoCallRecord(callRecordId, requestId);

    if (!voiceRecording || String(voiceRecording).trim() === '') {
        throw new Error(`Voice_Recording__s field is empty for call record ${callRecordId}`);
    }

    const voiceRecordingStr = String(voiceRecording).trim();

    // Check if Voice_Recording__s is a phonebridge URL (requires authentication, need to use Knowlarity)
    const isPhonebridgeUrl = voiceRecordingStr.includes('phonebridge.zoho.com');
    
    // Check if Voice_Recording__s is already a direct downloadable URL (http/https) that's NOT phonebridge
    if ((voiceRecordingStr.startsWith('http://') || voiceRecordingStr.startsWith('https://')) && !isPhonebridgeUrl) {
        console.log(`✅ [${requestId}] Voice_Recording__s is a direct downloadable URL. Using it: ${voiceRecordingStr}`);
        return voiceRecordingStr;
    }

    // If it's a phonebridge URL or not a direct URL, extract UUID and fetch from Knowlarity
    if (isPhonebridgeUrl) {
        console.log(`🔄 [${requestId}] Voice_Recording__s is a phonebridge URL (requires auth). Extracting UUID and fetching secured URL from Knowlarity...`);
    } else {
        console.log(`🔄 [${requestId}] Voice_Recording__s is not a direct URL. Extracting UUID and fetching from Knowlarity...`);
    }
    const uuid = extractUuid(voiceRecordingStr);

    if (!uuid) {
        throw new Error(`Could not extract recording ID from Voice_Recording__s: ${voiceRecordingStr}. Expected UUID or /recording/{id} format.`);
    }
    console.log(`🔑 [${requestId}] Extracted ID: ${uuid}`);

    const securedUrl = await fetchKnowlarityRecordingUrl(uuid, requestId);
    console.log(`🎯 [${requestId}] Fallback flow completed. Recording URL obtained: ${securedUrl}`);

    return securedUrl;
}

module.exports = { getRecordingUrlFromFallback };
