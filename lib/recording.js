const { fetchZohoCallRecord } = require('./zoho');
const { extractUuid, fetchKnowlarityRecordingUrl } = require('./knowlarity');

/**
 * Fallback: get recording URL via Zoho -> Knowlarity when Call_Recording_URL is missing
 */
async function getRecordingUrlFromFallback(callRecordId, requestId) {
    console.log(`🔄 [${requestId}] Starting fallback flow: Zoho -> Knowlarity`);

    const voiceRecording = await fetchZohoCallRecord(callRecordId, requestId);

    // Extract id from /recording/{id}?serviceID=... (e.g. phonebridge URL) or raw UUID
    const uuid = extractUuid(voiceRecording);
    if (!uuid) {
        throw new Error(`Could not extract recording ID from Voice_Recording__s: ${voiceRecording}`);
    }
    console.log(`🔑 [${requestId}] Extracted ID: ${uuid}`);

    const securedUrl = await fetchKnowlarityRecordingUrl(uuid, requestId);
    console.log(`🎯 [${requestId}] Fallback flow completed. Recording URL obtained: ${securedUrl}`);

    return securedUrl;
}

module.exports = { getRecordingUrlFromFallback };
