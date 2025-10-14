// index.js

const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

let zohoAuth = {
    accessToken: null,
    expiryTime: null,
};

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

app.get("/hello", (req, res) => {
    res.send("Hello World");
});

app.post('/process-audio', async (req, res) => {
    console.log(`Received new request to /process-audio`);
    const { Call_Record_ID, Call_Recording_URL } = req.body;
    console.log(`Received new request to /process-audio ${Call_Record_ID} ${Call_Recording_URL}`);
    let tempFilePath = null;

    try {
        const { Call_Record_ID, Call_Recording_URL } = req.body; 

        if (!Call_Record_ID || !Call_Recording_URL) {
            return res.status(400).json({ error: 'Missing required fields: id and recordingUrl' });
        }
        console.log(`Processing ID: ${Call_Record_ID} with URL: ${Call_Recording_URL}`);

        console.log('Downloading audio file...');
        const audioResponse = await axios.get(Call_Recording_URL, {
            responseType: 'arraybuffer',
            timeout: 30000, // 30 second timeout
        });
        console.log(`Downloaded ${audioResponse.data.byteLength} bytes`);

        // Detect file format from Content-Type header
        const contentType = audioResponse.headers['content-type'] || '';
        console.log(`Detected Content-Type: ${contentType}`);
        
        // Map content type to file extension
        let fileExtension = 'mp3'; // default
        if (contentType.includes('audio/wav') || contentType.includes('audio/wave')) {
            fileExtension = 'wav';
        } else if (contentType.includes('audio/mpeg') || contentType.includes('audio/mp3')) {
            fileExtension = 'mp3';
        } else if (contentType.includes('audio/mp4') || contentType.includes('audio/m4a')) {
            fileExtension = 'm4a';
        } else if (contentType.includes('audio/ogg')) {
            fileExtension = 'ogg';
        } else if (contentType.includes('audio/webm')) {
            fileExtension = 'webm';
        } else if (contentType.includes('audio/flac')) {
            fileExtension = 'flac';
        } else if (contentType.includes('video/mp4')) {
            fileExtension = 'mp4';
        } else {
            // Try to detect from URL or use magic number detection
            console.log('Could not detect format from Content-Type, checking URL and file signature...');
            
            // Check URL for extension
            const urlExt = recordingUrl.toLowerCase().match(/\.(mp3|wav|m4a|ogg|webm|flac|mp4|mpeg|mpga|oga)(\?|$)/);
            if (urlExt) {
                fileExtension = urlExt[1];
            } else {
                // Check file signature (magic numbers) from the buffer
                const buffer = Buffer.from(audioResponse.data);
                if (buffer.length > 12) {
                    // WAV file signature
                    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
                        fileExtension = 'wav';
                    }
                    // MP3 file signature (ID3 tag or MPEG frame sync)
                    else if (buffer.toString('ascii', 0, 3) === 'ID3' || 
                             (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)) {
                        fileExtension = 'mp3';
                    }
                    // OGG file signature
                    else if (buffer.toString('ascii', 0, 4) === 'OggS') {
                        fileExtension = 'ogg';
                    }
                    // MP4/M4A file signature
                    else if (buffer.toString('ascii', 4, 8) === 'ftyp') {
                        fileExtension = 'mp4';
                    }
                    // FLAC file signature
                    else if (buffer.toString('ascii', 0, 4) === 'fLaC') {
                        fileExtension = 'flac';
                    }
                }
            }
        }
        
        console.log(`Using file extension: .${fileExtension}`);

        // Save to temporary file with proper extension
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        tempFilePath = path.join(tempDir, `audio_${Call_Record_ID}_${Date.now()}.${fileExtension}`);
        fs.writeFileSync(tempFilePath, Buffer.from(audioResponse.data));
        console.log(`Audio saved temporarily to: ${tempFilePath}`);

        console.log('Sending audio to OpenAI Whisper for transcription...');
        const transcription = await openai.audio.transcriptions.create({
            model: 'whisper-1',
            file: fs.createReadStream(tempFilePath),
        });
        const transcriptText = transcription.text;
        console.log(`Transcription successful. Text: "${transcriptText}"`);

        const accessToken = await getZohoAccessToken();

        // Optionally generate AI analysis text
        const analysisEnabled = (process.env.ANALYSIS_ENABLED || 'true').toLowerCase() === 'true';
        const analysisModel = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-4o-mini';

        let analysisText = null;
        if (analysisEnabled) {
            try {
                console.log('Generating AI analysis for transcript...');
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
                if (analysisText && analysisText.length > 1200) {
                    analysisText = analysisText.slice(0, 1190) + '…';
                }
                console.log('AI analysis generated.');
            } catch (analysisError) {
                console.warn('Analysis generation failed. Proceeding without AI_Analysis field.', analysisError.message);
            }
        }

        // Update Zoho CRM with the transcription (+ optional analysis)
        const moduleApiName = 'Calls';


        console.log(`Updating Zoho CRM module '${moduleApiName}' record ${Call_Record_ID} with transcription...`);

        const basePayload = {
            data: [
                {
                    "Description": transcriptText,
                },
            ],
        };

        if (analysisText) {
            basePayload.data[0]["AI_Analysis"] = analysisText;
        }

        let zohoResponse;
        try {
            zohoResponse = await axios.put(
                `${process.env.ZOHO_API_DOMAIN}/${moduleApiName}/${Call_Record_ID}`,
                basePayload,
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                }
            );
        } catch (zErr) {
            // If Zoho rejects unknown field AI_Analysis, retry with Description only
            const zohoErrData = zErr.response?.data;
            const isFieldError = JSON.stringify(zohoErrData || {}).toLowerCase().includes('ai_analysis');
            if (analysisText && isFieldError) {
                console.warn('Zoho rejected AI_Analysis field. Retrying with Description only...');
                const fallbackPayload = { data: [ { "Description": transcriptText } ] };
                zohoResponse = await axios.put(
                    `${process.env.ZOHO_API_DOMAIN}/${moduleApiName}/${Call_Record_ID}`,
                    fallbackPayload,
                    {
                        headers: {
                            Authorization: `Zoho-oauthtoken ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
            } else {
                throw zErr;
            }
        }

        console.log('Zoho CRM API Response:', JSON.stringify(zohoResponse.data, null, 2));

        console.log('Zoho CRM updated successfully!');

        res.status(200).json({
            message: 'Audio transcribed and CRM updated successfully.',
            recordId: Call_Record_ID,
            transcript: transcriptText,
        });

    } catch (error) {
        console.error('An error occurred during processing:', error.response?.data || error.message);
        res.status(500).json({ error: 'An internal server error occurred.' });
    } finally {
        // Clean up temporary file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                console.log('Temporary file cleaned up.');
            } catch (cleanupError) {
                console.error('Failed to clean up temporary file:', cleanupError.message);
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running and listening on http://localhost:${PORT}`);
});
