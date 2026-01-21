const axios = require('axios');

let zohoAuth = {
    accessToken: null,
    expiryTime: null,
};

/**
 * Zoho CRM API v2 base URL. Uses ZOHO_API_DOMAIN; if it's only
 * https://www.zohoapis.com (or .in, .eu), appends /crm/v2.
 * Correct: https://www.zohoapis.com/crm/v2
 */
function getZohoCrmBase() {
    let base = (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com/crm/v8').replace(/\/$/, '');
    if (!base.includes('/crm/')) base = base + '/crm/v8';
    return base;
}

async function getZohoAccessToken() {
    console.log('Checking for Zoho access token...');

    if (zohoAuth.accessToken && zohoAuth.expiryTime > Date.now()) {
        console.log('Token is still valid. Using existing one.');
        return zohoAuth.accessToken;
    }

    console.log('Token is expired or missing. Refreshing...');
    try {
        const response = await axios.post(
            `${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`,
            null,
            {
                params: {
                    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
                    client_id: process.env.ZOHO_CLIENT_ID,
                    client_secret: process.env.ZOHO_CLIENT_SECRET,
                    grant_type: 'refresh_token',
                },
            }
        );

        const newAccessToken = response.data.access_token;
        const expiresIn = response.data.expires_in;
        const newExpiryTime = Date.now() + (expiresIn - 300) * 1000;

        zohoAuth = {
            accessToken: newAccessToken,
            expiryTime: newExpiryTime,
        };

        console.log('Successfully refreshed Zoho access token.');
        return newAccessToken;
    } catch (error) {
        console.error('FATAL: Could not refresh Zoho access token:', error.response?.data || error.message);
        throw new Error('Failed to get Zoho access token.');
    }
}

/**
 * Fetch call record from Zoho CRM using COQL API and extract Voice_Recording__s field
 */
async function fetchZohoCallRecord(callRecordId, requestId) {
    console.log(`📞 [${requestId}] Fetching call record from Zoho CRM using COQL: ${callRecordId}`);

    const accessToken = await getZohoAccessToken();
    // Extract base domain (remove any /crm/v* paths)
    let baseUrl = (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com').replace(/\/$/, '');
    // Remove any existing /crm/v* path to avoid duplication
    baseUrl = baseUrl.replace(/\/crm\/v\d+.*$/, '');
    // Try v8 first (since regular API uses v8), then v2 as fallback
    const apiVersions = ['v8', 'v2'];
    
    let lastError = null;
    
    for (const version of apiVersions) {
        const coqlUrl = `${baseUrl}/crm/${version}/coql`;
        console.log(`🔗 [${requestId}] Trying COQL URL: ${coqlUrl}`);
    
        // Try different field name formats - COQL might need the field without __s or with different format
        // First try with SELECT * to get all fields, then try specific field names
        const fieldVariations = [
            '*',  // Select all fields first
            'Voice_Recording__s',  // Original format
            'Voice_Recording',     // Without __s suffix
        ];
        
        for (const fieldName of fieldVariations) {
            const coqlQuery = {
                select_query: `SELECT ${fieldName} FROM Calls WHERE id = '${callRecordId}'`
            };

            console.log(`📝 [${requestId}] Trying COQL Query with field: ${fieldName}`);
            console.log(`📝 [${requestId}] Full Query: ${coqlQuery.select_query}`);

        try {
            const response = await axios.post(coqlUrl, coqlQuery, {
                headers: {
                    Authorization: `Zoho-oauthtoken ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            });

            console.log(`📥 [${requestId}] Response status: ${response.status}`);
            console.log(`📥 [${requestId}] Response data keys:`, Object.keys(response.data || {}));

            if (!response.data?.data || response.data.data.length === 0) {
                console.error(`❌ [${requestId}] Full response:`, JSON.stringify(response.data, null, 2));
                throw new Error(`No data found in Zoho COQL response for Call Record ID: ${callRecordId}`);
            }

            const callRecord = response.data.data[0];
            console.log(`📋 [${requestId}] Call record fields:`, Object.keys(callRecord).join(', '));
            
            // Try to find the voice recording field with different possible names
            const voiceRecording = callRecord.Voice_Recording__s || 
                                  callRecord.voice_recording__s || 
                                  callRecord.Voice_Recording ||
                                  callRecord.voice_recording ||
                                  Object.values(callRecord).find(val => typeof val === 'string' && val.includes('phonebridge'));

            if (!voiceRecording) {
                console.error(`❌ [${requestId}] Full call record:`, JSON.stringify(callRecord, null, 2));
                throw new Error(`Voice_Recording__s field not found or is null in call record ${callRecordId}. Available fields: ${Object.keys(callRecord).join(', ')}`);
            }

            console.log(`✅ [${requestId}] Successfully fetched Voice_Recording__s from Zoho: ${voiceRecording}`);
            return voiceRecording;
            } catch (error) {
                lastError = error;
                // If it's an INVALID_QUERY error, try next field variation
                if (error.response?.data?.code === 'INVALID_QUERY') {
                    console.log(`⚠️ [${requestId}] Field name '${fieldName}' is invalid, trying next variation...`);
                    continue;
                }
                // If it's an API_NOT_SUPPORTED error, try next API version
                if (error.response?.data?.code === 'API_NOT_SUPPORTED') {
                    console.log(`⚠️ [${requestId}] API version ${version} not supported, trying next version...`);
                    break; // Break out of field loop to try next API version
                }
                // For other errors, break out of both loops
                break;
            }
        }
        
        // If we got a non-API_NOT_SUPPORTED error, don't try next version
        if (lastError && lastError.response?.data?.code !== 'API_NOT_SUPPORTED') {
            break;
        }
        // Reset lastError for next version attempt
        lastError = null;
    }
    
    // If we get here, all field variations and API versions failed
    if (lastError) {
        console.error(`❌ [${requestId}] Failed to fetch Zoho call record via COQL:`, lastError.message);
        if (lastError.response) {
            const zohoError = lastError.response.data;
            const status = lastError.response.status;
            console.error(`Zoho COQL API Error (${status}):`, JSON.stringify(zohoError, null, 2));

            let errorMessage = `Zoho COQL API returned ${status} error`;
            if (zohoError && typeof zohoError === 'object') {
                if (zohoError.code) errorMessage += ` (Code: ${zohoError.code})`;
                if (zohoError.message) errorMessage += ` - ${zohoError.message}`;
                if (zohoError.details) errorMessage += ` - Details: ${JSON.stringify(zohoError.details)}`;
            } else if (typeof zohoError === 'string') {
                errorMessage += ` - ${zohoError}`;
            } else {
                errorMessage += ` - ${lastError.message}`;
            }
            throw new Error(errorMessage);
        }
        throw new Error(`Failed to fetch call record from Zoho via COQL: ${lastError.message}`);
    }
    
    throw new Error(`All field name variations failed for Voice_Recording__s in call record ${callRecordId}`);
}

module.exports = { getZohoAccessToken, getZohoCrmBase, fetchZohoCallRecord };
