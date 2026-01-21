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

/**
 * Extract secured_recording_url from Knowlarity response.
 * Handles nested JSON, stringified JSON, and various response structures.
 */
function extractSecuredUrl(knJson) {
    if (!knJson) return '';

    // If response is a string, try to parse it
    if (typeof knJson === 'string') {
        try {
            knJson = JSON.parse(knJson);
        } catch {
            // If parsing fails, try regex extraction from string
            const urlRegex = /"secured_recording_url"\s*:\s*"([^"]+)"/;
            const match = knJson.match(urlRegex);
            if (match) return match[1];
            return '';
        }
    }

    if (typeof knJson !== 'object') return '';

    // Direct access
    if (knJson.secured_recording_url) return knJson.secured_recording_url;

    // Recursive search in nested objects
    function searchNested(obj, depth = 0) {
        if (depth > 5) return null; // Prevent infinite recursion
        if (!obj || typeof obj !== 'object') return null;

        // Check direct property
        if (obj.secured_recording_url) return obj.secured_recording_url;

        // Check all properties
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const value = obj[key];
                
                // If value is a string that might be JSON, try parsing it
                if (typeof value === 'string' && value.trim().startsWith('{')) {
                    try {
                        const parsed = JSON.parse(value);
                        const found = searchNested(parsed, depth + 1);
                        if (found) return found;
                    } catch {
                        // Try regex on stringified JSON
                        const urlRegex = /"secured_recording_url"\s*:\s*"([^"]+)"/;
                        const match = value.match(urlRegex);
                        if (match) return match[1];
                    }
                }
                
                // If value is an object, search recursively
                if (typeof value === 'object' && value !== null) {
                    const found = searchNested(value, depth + 1);
                    if (found) return found;
                }
            }
        }
        return null;
    }

    const found = searchNested(knJson);
    if (found) return found;

    // Last resort: try to find it in any stringified JSON anywhere in the response
    const responseStr = JSON.stringify(knJson);
    const urlRegex = /"secured_recording_url"\s*:\s*"([^"]+)"/;
    const match = responseStr.match(urlRegex);
    return match ? match[1] : '';
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

        if (!securedUrl) {
            console.error(`❌ [${requestId}] Full Knowlarity response:`, JSON.stringify(response.data, null, 2));
            throw new Error('secured_recording_url not found in Knowlarity response');
        }

        console.log(`✅ [${requestId}] Successfully fetched secured_recording_url from Knowlarity: ${securedUrl}`);
        return securedUrl;
    } catch (error) {
        console.error(`❌ [${requestId}] Failed to fetch Knowlarity recording URL:`, error.message);
        if (error.response) console.error('Knowlarity API Error:', error.response.data);
        throw new Error(`Failed to fetch recording URL from Knowlarity: ${error.message}`);
    }
}

module.exports = { extractUuid, extractSecuredUrl, fetchKnowlarityRecordingUrl };
