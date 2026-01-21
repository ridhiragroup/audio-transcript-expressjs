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
    let base = (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com/crm/v2').replace(/\/$/, '');
    if (!base.includes('/crm/')) base = base + '/crm/v2';
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
 * Fetch call record from Zoho CRM and extract Voice_Recording__s field
 */
async function fetchZohoCallRecord(callRecordId, requestId) {
    console.log(`📞 [${requestId}] Fetching call record from Zoho CRM: ${callRecordId}`);

    const accessToken = await getZohoAccessToken();
    const zohoUrl = `${getZohoCrmBase()}/Calls/${callRecordId}`;

    try {
        const response = await axios.get(zohoUrl, {
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });

        if (!response.data?.data?.[0]) {
            throw new Error(`No data found in Zoho response for Call Record ID: ${callRecordId}`);
        }

        const callRecord = response.data.data[0];
        const voiceRecording = callRecord.Voice_Recording__s || callRecord.voice_recording__s || callRecord.Voice_Recording;

        if (!voiceRecording) {
            throw new Error(`Voice_Recording__s field not found in call record ${callRecordId}`);
        }

        console.log(`✅ [${requestId}] Successfully fetched Voice_Recording__s from Zoho: ${voiceRecording}`);
        return voiceRecording;
    } catch (error) {
        console.error(`❌ [${requestId}] Failed to fetch Zoho call record:`, error.message);
        if (error.response) {
            const zohoError = error.response.data;
            const status = error.response.status;
            console.error(`Zoho API Error (${status}):`, JSON.stringify(zohoError, null, 2));
            console.error(`Zoho API URL: ${zohoUrl}`);

            let errorMessage = `Zoho API returned ${status} error`;
            if (zohoError && typeof zohoError === 'object') {
                if (zohoError.code) errorMessage += ` (Code: ${zohoError.code})`;
                if (zohoError.message) errorMessage += ` - ${zohoError.message}`;
                if (zohoError.details) errorMessage += ` - Details: ${JSON.stringify(zohoError.details)}`;
            } else if (typeof zohoError === 'string') {
                errorMessage += ` - ${zohoError}`;
            } else {
                errorMessage += ` - ${error.message}`;
            }
            throw new Error(errorMessage);
        }
        throw new Error(`Failed to fetch call record from Zoho: ${error.message}`);
    }
}

module.exports = { getZohoAccessToken, getZohoCrmBase, fetchZohoCallRecord };
