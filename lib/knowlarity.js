const axios = require('axios');

/**
 * Extract recording ID from Voice_Recording__s.
 * - URL like /recording/{id}?serviceID=... (e.g. phonebridge.zoho.com/.../recording/11aff2d5-39e7-4a0b-b7cd-461fde93f44c?serviceID=...)
 *   -> extract "11aff2d5-39e7-4a0b-b7cd-461fde93f44c"
 * - Raw UUID string -> return as-is
 */
function extractUuid(value) {
    if (!value) return '';
    const s = String(value).trim();
    // 1) /recording/{id}? or /recording/{id} (id = UUID or similar)
    const recordingPath = /\/recording\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
    let m = s.match(recordingPath);
    if (m) return m[1];
    // 2) /recording/{any-id} in case id format differs
    const recordingPathAny = /\/recording\/([^/?]+)/;
    m = s.match(recordingPathAny);
    if (m) return m[1];
    // 3) plain UUID anywhere
    const uuidRegex = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
    m = s.match(uuidRegex);
    return m ? m[1] : '';
}

function extractSecuredUrl(knJson) {
    if (!knJson || typeof knJson !== 'object') return '';

    if (knJson.secured_recording_url) return knJson.secured_recording_url;

    const message = knJson.message;
    if (typeof message === 'string' && message.trim()) {
        try {
            const inner = JSON.parse(message);
            if (inner?.secured_recording_url) return inner.secured_recording_url;
        } catch {
            const urlRegex = /"secured_recording_url"\s*:\s*"([^"]+)"/;
            const match = message.match(urlRegex);
            if (match) return match[1];
        }
    }
    return '';
}

async function fetchKnowlarityRecordingUrl(uuid, requestId) {
    console.log(`🔗 [${requestId}] Fetching recording URL from Knowlarity for UUID: ${uuid}`);

    const knowlarityBase = process.env.KNOWLARITY_BASE_URL || 'https://kpi.knowlarity.com';
    const knowlarityUrl = `${knowlarityBase}/Basic/v1/account/call/get-detailed-call-log`;

    const headers = {
        channel: 'Basic',
        'x-api-key': process.env.KNOWLARITY_API_KEY,
        authorization: process.env.KNOWLARITY_AUTH_TOKEN,
        'content-type': 'application/json',
        'cache-control': 'no-cache',
    };

    if (!process.env.KNOWLARITY_API_KEY || !process.env.KNOWLARITY_AUTH_TOKEN) {
        throw new Error('Knowlarity credentials (KNOWLARITY_API_KEY and KNOWLARITY_AUTH_TOKEN) are required but not configured');
    }

    try {
        const response = await axios.get(knowlarityUrl, {
            headers,
            params: { uuid },
            timeout: 30000,
        });

        console.log("knowlarity response.data", response.data);

        const securedUrl = extractSecuredUrl(response.data);
        console.log("securedUrl", securedUrl);
        // if (!securedUrl) {
        //     console.error(`❌ [${requestId}] Knowlarity response keys:`, Object.keys(response.data || {}));
        //     throw new Error('secured_recording_url not found in Knowlarity response');
        // }

        // console.log(`✅ [${requestId}] Successfully fetched secured_recording_url from Knowlarity`);
        // return securedUrl;
    } catch (error) {
        console.error(`❌ [${requestId}] Failed to fetch Knowlarity recording URL:`, error.message);
        if (error.response) console.error('Knowlarity API Error:', error.response.data);
        throw new Error(`Failed to fetch recording URL from Knowlarity: ${error.message}`);
    }
}

module.exports = { extractUuid, extractSecuredUrl, fetchKnowlarityRecordingUrl };
