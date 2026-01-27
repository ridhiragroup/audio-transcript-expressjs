const { fetchZohoCallRecord } = require('./zoho');
const { extractUuid, fetchKnowlarityRecordingUrl } = require('./knowlarity');

/**
 * Get recording URL from Voice_Recording__s field.
 * Handles multiple cases:
 * 1. Direct downloadable URL (http/https) -> use it directly
 * 2. UUID or /recording/{id} path -> extract UUID and fetch from Knowlarity
 */
async function getRecordingUrlFromFallback(callRecordId, requestId) {
    console.log(`🔄 [${requestId}] Fetching Voice_Recording__s from Zoho CRM...`);

    const voiceRecording = await fetchZohoCallRecord(callRecordId, requestId);

    if (!voiceRecording || String(voiceRecording).trim() === '') {
        throw new Error(`Voice_Recording__s field is empty for call record ${callRecordId}`);
    }

    const voiceRecordingStr = String(voiceRecording).trim();

    // Check if Voice_Recording__s is already a direct downloadable URL (http/https)
    if (voiceRecordingStr.startsWith('http://') || voiceRecordingStr.startsWith('https://')) {
        console.log(`✅ [${requestId}] Voice_Recording__s is a direct URL. Using it: ${voiceRecordingStr}`);
        return voiceRecordingStr;
    }

    // Otherwise, extract UUID and fetch from Knowlarity
    console.log(`🔄 [${requestId}] Voice_Recording__s is not a direct URL. Extracting UUID and fetching from Knowlarity...`);
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
