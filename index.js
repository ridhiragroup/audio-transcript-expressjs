// index.js

const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
require('dotenv').config();

const app = express();

// Enhanced body parsing middleware for Azure Web Apps compatibility
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
app.use(express.text({ type: 'text/plain', limit: '50mb' }));

// Debug middleware to log request details
app.use((req, res, next) => {
    console.log(`=== REQUEST DEBUG ===`);
    console.log(`Method: ${req.method}`);
    console.log(`URL: ${req.url}`);
    console.log(`Content-Type: ${req.get('Content-Type')}`);
    console.log(`Content-Length: ${req.get('Content-Length')}`);
    console.log(`Headers:`, JSON.stringify(req.headers, null, 2));
    console.log(`Body type:`, typeof req.body);
    console.log(`Body content:`, req.body);
    console.log(`=== END REQUEST DEBUG ===`);
    next();
});

// ===== ENHANCED CONCURRENCY CONTROL SYSTEM =====

class RequestQueue extends EventEmitter {
    constructor(maxConcurrent = 5, maxQueueSize = 100) {
        super();
        this.queue = [];
        this.activeRequests = new Map(); // Changed to Map for better tracking
        this.maxConcurrent = maxConcurrent;
        this.maxQueueSize = maxQueueSize;
        this.requestStats = {
            total: 0,
            completed: 0,
            failed: 0,
            queued: 0,
            processing: 0
        };
        this.startTime = Date.now();
        
        console.log(`🚀 RequestQueue initialized - Max Concurrent: ${maxConcurrent}, Max Queue Size: ${maxQueueSize}`);
    }

    async addRequest(requestId, requestHandler, requestData) {
        return new Promise((resolve, reject) => {
            if (this.queue.length >= this.maxQueueSize) {
                console.warn(`⚠️  Queue is full (${this.maxQueueSize}). Rejecting request ${requestId}`);
                reject(new Error(`Queue is full. Maximum ${this.maxQueueSize} requests can be queued. Please try again later.`));
                return;
            }

            const request = {
                id: requestId,
                handler: requestHandler,
                data: requestData,
                resolve,
                reject,
                startTime: Date.now(),
                queueTime: Date.now(),
                status: 'queued'
            };

            this.queue.push(request);
            this.requestStats.total++;
            this.requestStats.queued++;

            console.log(`📥 Request ${requestId} queued. Queue: ${this.queue.length}, Active: ${this.activeRequests.size}, Total: ${this.requestStats.total}`);

            // Emit event for monitoring
            this.emit('requestQueued', { requestId, queueLength: this.queue.length });

            this.processQueue();
        });
    }

    async processQueue() {
        while (this.queue.length > 0 && this.activeRequests.size < this.maxConcurrent) {
            const request = this.queue.shift();
            this.activeRequests.set(request.id, request);
            this.requestStats.queued--;
            this.requestStats.processing++;

            const waitTime = Date.now() - request.queueTime;
            console.log(`🔄 Processing request ${request.id} (waited ${waitTime}ms). Active: ${this.activeRequests.size}, Queue: ${this.queue.length}`);

            try {
                request.status = 'processing';
                const result = await request.handler();
                request.resolve(result);
                this.requestStats.completed++;
                
                const totalTime = Date.now() - request.startTime;
                const processingTime = Date.now() - (request.startTime + waitTime);
                console.log(`✅ Request ${request.id} completed successfully - Total: ${totalTime}ms, Processing: ${processingTime}ms`);
                
                this.emit('requestCompleted', { 
                    requestId: request.id, 
                    totalTime, 
                    processingTime, 
                    waitTime 
                });
                
            } catch (error) {
                request.reject(error);
                this.requestStats.failed++;
                
                const totalTime = Date.now() - request.startTime;
                console.error(`❌ Request ${request.id} failed after ${totalTime}ms:`, error.message);
                
                this.emit('requestFailed', { 
                    requestId: request.id, 
                    error: error.message, 
                    totalTime 
                });
                
            } finally {
                this.activeRequests.delete(request.id);
                this.requestStats.processing--;
                
                // Process next request in queue
                setImmediate(() => this.processQueue());
            }
        }
    }

    getStats() {
        const uptime = Date.now() - this.startTime;
        const avgProcessingTime = this.requestStats.completed > 0 ? 
            (uptime / this.requestStats.completed) : 0;
        
        return {
            ...this.requestStats,
            queueLength: this.queue.length,
            activeRequests: this.activeRequests.size,
            maxConcurrent: this.maxConcurrent,
            maxQueueSize: this.maxQueueSize,
            uptime: Math.round(uptime / 1000),
            avgProcessingTime: Math.round(avgProcessingTime),
            throughput: this.requestStats.completed / (uptime / 1000 / 60) // requests per minute
        };
    }

    getActiveRequestDetails() {
        const activeDetails = [];
        for (const [id, request] of this.activeRequests) {
            activeDetails.push({
                id: request.id,
                status: request.status,
                processingTime: Date.now() - request.startTime,
                data: request.data ? { 
                    Call_Record_ID: request.data.Call_Record_ID,
                    Call_Recording_URL: request.data.Call_Recording_URL ? 'present' : 'missing'
                } : null
            });
        }
        return activeDetails;
    }

    clearQueue() {
        const queuedCount = this.queue.length;
        this.queue.forEach(request => {
            request.reject(new Error('Queue cleared by administrator'));
        });
        this.queue = [];
        this.requestStats.queued = 0;
        console.log(`🧹 Cleared ${queuedCount} queued requests`);
        this.emit('queueCleared', { clearedCount: queuedCount });
    }
}

// Initialize request queue with configurable limits
const requestQueue = new RequestQueue(
    parseInt(process.env.MAX_CONCURRENT_REQUESTS || '5'),
    parseInt(process.env.MAX_QUEUE_SIZE || '100')
);

// Enhanced rate limiting middleware
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '20'); // Max requests per minute per IP

function rateLimitMiddleware(req, res, next) {
    const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    
    if (!rateLimitMap.has(clientIp)) {
        rateLimitMap.set(clientIp, { count: 0, resetTime: now + RATE_LIMIT_WINDOW });
    }
    
    const clientData = rateLimitMap.get(clientIp);
    
    if (now > clientData.resetTime) {
        clientData.count = 0;
        clientData.resetTime = now + RATE_LIMIT_WINDOW;
    }
    
    if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
        console.warn(`🚫 Rate limit exceeded for IP: ${clientIp} (${clientData.count}/${RATE_LIMIT_MAX_REQUESTS})`);
        return res.status(429).json({
            error: 'Rate limit exceeded',
            message: `Maximum ${RATE_LIMIT_MAX_REQUESTS} requests per minute allowed`,
            retryAfter: Math.ceil((clientData.resetTime - now) / 1000),
            clientIp: clientIp
        });
    }
    
    clientData.count++;
    console.log(`📊 Rate limit check for ${clientIp}: ${clientData.count}/${RATE_LIMIT_MAX_REQUESTS}`);
    next();
}

// Apply rate limiting to process-audio endpoint
app.use('/process-audio', rateLimitMiddleware);

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

// Fallback endpoint for different webhook formats
app.post('/webhook', async (req, res) => {
    console.log('Fallback webhook endpoint called');
    // Forward to the main processing endpoint
    req.url = '/process-audio';
    return app._router.handle(req, res);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Enhanced queue status endpoint
app.get('/queue-status', (req, res) => {
    const stats = requestQueue.getStats();
    const activeDetails = requestQueue.getActiveRequestDetails();
    const memoryUsage = process.memoryUsage();
    
    res.status(200).json({
        timestamp: new Date().toISOString(),
        queue: stats,
        activeRequests: activeDetails,
        memory: {
            used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
            total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            external: Math.round(memoryUsage.external / 1024 / 1024),
            rss: Math.round(memoryUsage.rss / 1024 / 1024)
        },
        environment: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            uptime: Math.round(process.uptime())
        }
    });
});

// Clear queue endpoint (for emergency use)
app.post('/clear-queue', (req, res) => {
    const statsBefore = requestQueue.getStats();
    requestQueue.clearQueue();
    const statsAfter = requestQueue.getStats();
    
    console.log(`🧹 Queue cleared by administrator. Cleared ${statsBefore.queueLength} requests`);
    
    res.status(200).json({ 
        message: 'Queue cleared successfully',
        clearedRequests: statsBefore.queueLength,
        currentStats: statsAfter
    });
});

// Request details endpoint
app.get('/request/:requestId', (req, res) => {
    const { requestId } = req.params;
    const activeDetails = requestQueue.getActiveRequestDetails();
    const activeRequest = activeDetails.find(req => req.id === requestId);
    
    if (activeRequest) {
        res.status(200).json({
            requestId: requestId,
            status: 'active',
            details: activeRequest
        });
    } else {
        res.status(404).json({
            error: 'Request not found',
            message: `Request ${requestId} is not currently active`
        });
    }
});

app.post('/process-audio', async (req, res) => {
    console.log(`🎯 Received new request to /process-audio`);
    
    // Generate unique request ID
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
        // Add request to queue
        const result = await requestQueue.addRequest(requestId, async () => {
            return await processAudioRequest(req.body, requestId);
        }, req.body);
        
        console.log(`🎉 Request ${requestId} completed successfully`);
        res.status(200).json(result);
        
    } catch (error) {
        console.error(`💥 Request ${requestId} failed:`, error.message);
        
        if (error.message.includes('Queue is full')) {
            res.status(503).json({
                error: 'Service temporarily unavailable',
                message: 'Server is at capacity. Please try again later.',
                requestId: requestId,
                queueStats: requestQueue.getStats()
            });
        } else {
            res.status(500).json({
                error: 'Internal server error',
                message: error.message,
                requestId: requestId
            });
        }
    }
});

// Extract the main processing logic into a separate function
async function processAudioRequest(requestBody, requestId) {
    console.log(`🔧 Processing audio request ${requestId}`);
    let tempFilePath = null;
    const startTime = Date.now();

    try {
        // Handle different request body formats
        let requestData = null;
        
        // Try to parse request body based on content type
        if (requestBody && typeof requestBody === 'object') {
            requestData = requestBody;
        } else if (typeof requestBody === 'string') {
            try {
                requestData = JSON.parse(requestBody);
            } catch (parseError) {
                console.log(`🔍 [${requestId}] Failed to parse JSON from string body:`, parseError.message);
                // Try to parse as URL-encoded data
                try {
                    const querystring = require('querystring');
                    requestData = querystring.parse(requestBody);
                } catch (urlParseError) {
                    console.log(`🔍 [${requestId}] Failed to parse as URL-encoded:`, urlParseError.message);
                    requestData = null;
                }
            }
        }
        
        console.log(`📋 [${requestId}] Parsed request data:`, JSON.stringify(requestData, null, 2));
        
        if (!requestData) {
            throw new Error(`Unable to parse request body. Body type: ${typeof requestBody}`);
        }

        const { Call_Record_ID, Call_Recording_URL } = requestData;
        console.log(`🎯 [${requestId}] Processing ID: ${Call_Record_ID} with URL: ${Call_Recording_URL}`);

        if (!Call_Record_ID || !Call_Recording_URL) {
            throw new Error(`Missing required fields: Call_Record_ID and Call_Recording_URL. Received: ${JSON.stringify(requestData)}`);
        }

        console.log(`📥 [${requestId}] Downloading audio file from: ${Call_Recording_URL}`);
        const audioResponse = await axios.get(Call_Recording_URL, {
            responseType: 'arraybuffer',
            timeout: 30000, // 30 second timeout
        });
        console.log(`📦 [${requestId}] Downloaded ${audioResponse.data.byteLength} bytes`);

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
            const urlExt = Call_Recording_URL.toLowerCase().match(/\.(mp3|wav|m4a|ogg|webm|flac|mp4|mpeg|mpga|oga)(\?|$)/);
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

        console.log(`🎤 [${requestId}] Sending audio to OpenAI Whisper for transcription...`);
        const transcription = await openai.audio.transcriptions.create({
            model: 'whisper-1',
            file: fs.createReadStream(tempFilePath),
        });
        const transcriptText = transcription.text;
        console.log(`📝 [${requestId}] Transcription successful. Length: ${transcriptText.length} characters`);

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

        console.log(`✅ [${requestId}] Zoho CRM updated successfully!`);

        return {
            message: 'Audio transcribed and CRM updated successfully.',
            recordId: Call_Record_ID,
            transcript: transcriptText,
            requestId: requestId,
            processingTime: Date.now() - startTime
        };

    } catch (error) {
        const processingTime = Date.now() - startTime;
        console.error(`💥 [${requestId}] Error occurred during processing after ${processingTime}ms:`, {
            message: error.message,
            stack: error.stack,
            response: error.response?.data,
            status: error.response?.status,
            headers: error.response?.headers
        });
        
        // Re-throw the error so the queue can handle it
        throw error;
    } finally {
        // Clean up temporary file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                console.log(`🧹 [${requestId}] Temporary file cleaned up: ${tempFilePath}`);
            } catch (cleanupError) {
                console.error(`❌ [${requestId}] Failed to clean up temporary file:`, cleanupError.message);
            }
        }
    }
    === END REQUEST DEBUG ===
    📊 Rate limit check for ::1: 20/20
    🎯 Received new request to /process-audio
    📥 Request req_1760509416730_48fvq8h31 queued. Queue: 8, Active: 5, Total: 20
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:36+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-04T15:36:23+05:30",
            "id": "5924956000113196970",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509385917_36q18y0bn] Zoho CRM updated successfully!
    🧹 [req_1760509385917_36q18y0bn] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000113196970_1760509407894.mp3
    ✅ Request req_1760509385917_36q18y0bn completed successfully - Total: 31010ms, Processing: 9728ms
    🔄 Processing request req_1760509390220_syygird6j (waited 26709ms). Active: 5, Queue: 7
    🔧 Processing audio request req_1760509390220_syygird6j
    📋 [req_1760509390220_syygird6j] Parsed request data: {
      "Call_Record_ID": "5924956000115719832",
      "Call_Recording_URL": "https://play.kaleyra.com/?id=MTk1MDI3NzM1NjY4NGJhZjQ4YzQ3YWUyLjUyOTYyMjl8MTc0OTc5MDUzNg==" 
    }
    🎯 [req_1760509390220_syygird6j] Processing ID: 5924956000115719832 with URL: https://play.kaleyra.com/?id=MTk1MDI3NzM1NjY4NGJhZjQ4YzQ3YWUyLjUyOTYyMjl8MTc0OTc5MDUzNg==
    📥 [req_1760509390220_syygird6j] Downloading audio file from: https://play.kaleyra.com/?id=MTk1MDI3NzM1NjY4NGJhZjQ4YzQ3YWUyLjUyOTYyMjl8MTc0OTc5MDUzNg==
    🎉 Request req_1760509385917_36q18y0bn completed successfully
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000165148646 with transcription...
    📝 [req_1760509389324_ocz8clsa4] Transcription successful. Length: 39 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:37+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-08-02T14:43:16+05:30",
            "id": "5924956000134351795",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509384959_tu3yscl94] Zoho CRM updated successfully!
    🧹 [req_1760509384959_tu3yscl94] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000134351795_1760509407972.mp3
    ✅ Request req_1760509384959_tu3yscl94 completed successfully - Total: 32985ms, Processing: 10853ms
    🔄 Processing request req_1760509391380_61ff2u3dl (waited 26567ms). Active: 5, Queue: 6
    🔧 Processing audio request req_1760509391380_61ff2u3dl
    📋 [req_1760509391380_61ff2u3dl] Parsed request data: {
      "Call_Record_ID": "5924956000165132674",
      "Call_Recording_URL": "https://play.kaleyra.com/?id=OTc0NTQ5ODE5NjhlZjNkODQ3OWE1MzcuMDk2OTA2NjV8MTc2MDUwOTMxNg==" 
    }
    🎯 [req_1760509391380_61ff2u3dl] Processing ID: 5924956000165132674 with URL: https://play.kaleyra.com/?id=OTc0NTQ5ODE5NjhlZjNkODQ3OWE1MzcuMDk2OTA2NjV8MTc2MDUwOTMxNg==
    📥 [req_1760509391380_61ff2u3dl] Downloading audio file from: https://play.kaleyra.com/?id=OTc0NTQ5ODE5NjhlZjNkODQ3OWE1MzcuMDk2OTA2NjV8MTc2MDUwOTMxNg==
    🎉 Request req_1760509384959_tu3yscl94 completed successfully
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:37+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-10-15T11:53:05+05:30",
            "id": "5924956000165148646",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509386137_yis7apl8a] Zoho CRM updated successfully!
    🧹 [req_1760509386137_yis7apl8a] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000165148646_1760509408273.wav
    ✅ Request req_1760509386137_yis7apl8a completed successfully - Total: 31867ms, Processing: 10749ms
    🔄 Processing request req_1760509410225_ul8n52hvx (waited 7780ms). Active: 5, Queue: 5
    🔧 Processing audio request req_1760509410225_ul8n52hvx
    📋 [req_1760509410225_ul8n52hvx] Parsed request data: {
      "Call_Record_ID": "5924956000113008285",
      "Call_Recording_URL": "https://play.kaleyra.com/?id=Nzg1NTM3NDE5NjgzZmMzNzhkNTFmMDAuMjY2NzgyNjF8MTc0OTAwOTI3Mg==" 
    }
    🎯 [req_1760509410225_ul8n52hvx] Processing ID: 5924956000113008285 with URL: https://play.kaleyra.com/?id=Nzg1NTM3NDE5NjgzZmMzNzhkNTFmMDAuMjY2NzgyNjF8MTc0OTAwOTI3Mg==
    📥 [req_1760509410225_ul8n52hvx] Downloading audio file from: https://play.kaleyra.com/?id=Nzg1NTM3NDE5NjgzZmMzNzhkNTFmMDAuMjY2NzgyNjF8MTc0OTAwOTI3Mg==
    🎉 Request req_1760509386137_yis7apl8a completed successfully
    📝 [req_1760509387010_ds4qieaqd] Transcription successful. Length: 150 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    📦 [req_1760509390220_syygird6j] Downloaded 91584 bytes
    Detected Content-Type: audio/mpeg
    Using file extension: .mp3
    Audio saved temporarily to: C:\Users\Preopening\Downloads\audio-processor\audio-processor\temp\audio_5924956000115719832_1760509418252.mp3
    🎤 [req_1760509390220_syygird6j] Sending audio to OpenAI Whisper for transcription...
    📦 [req_1760509410225_ul8n52hvx] Downloaded 36432 bytes
    Detected Content-Type: audio/mpeg
    Using file extension: .mp3
    Audio saved temporarily to: C:\Users\Preopening\Downloads\audio-processor\audio-processor\temp\audio_5924956000113008285_1760509418563.mp3
    🎤 [req_1760509410225_ul8n52hvx] Sending audio to OpenAI Whisper for transcription...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "b04ccbe2-7b6c-4c8f-9468-2feeacfa78ec",
      "client-ip": "136.143.177.62:50690",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.62:50690",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.62",
      "x-client-port": "50690",
      "content-type": "application/json",
      "timestamp": "1760509418268",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000115387498',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=NzUzMjg2OTY4Njg0OTgyYjZjZDBmNzYuOTc1MDUzNjN8MTc0OTY0ODA1NA=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "0af3c12f-2dca-4c41-b71c-906affdc111f",
      "client-ip": "136.143.177.62:51732",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.62:51732",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.62",
      "x-client-port": "51732",
      "content-type": "application/json",
      "timestamp": "1760509418301",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000113766323',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=MTUyNTM5NDg2NjY4NDE5Nzk5MjAzNDc3LjI5ODA3Nzh8MTc0OTEyOTExMw=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    📦 [req_1760509391380_61ff2u3dl] Downloaded 626284 bytes
    Detected Content-Type: audio/x-wav
    Could not detect format from Content-Type, checking URL and file signature...
    Using file extension: .wav
    Audio saved temporarily to: C:\Users\Preopening\Downloads\audio-processor\audio-processor\temp\audio_5924956000165132674_1760509418888.wav
    🎤 [req_1760509391380_61ff2u3dl] Sending audio to OpenAI Whisper for transcription...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "b31b293a-9260-429e-84b6-1aeca62c43c7",
      "client-ip": "136.143.177.62:42922",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.62:42922",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.62",
      "x-client-port": "42922",
      "content-type": "application/json",
      "timestamp": "1760509419131",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000114133818',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=OTMwODQ3NDQwNjg0MmQ3ODQxZmJhNTYuMjI5Njk4OTZ8MTc0OTIxMTAxMg=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    📝 [req_1760509390220_syygird6j] Transcription successful. Length: 103 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "daba0013-94db-47f5-8fa2-17cb20c3a305",
      "client-ip": "136.143.177.61:48226",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.61:48226",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.61",
      "x-client-port": "48226",
      "content-type": "application/json",
      "timestamp": "1760509419500",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000115827140',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=OTYzODU1MTE2Njg0YmI2NTBhMDdjYTYuNDI5ODcxNTh8MTc0OTc5MjMzNg=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000115479503 with transcription...
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:40+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-11T18:39:08+05:30",
            "id": "5924956000115479503",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509389324_ocz8clsa4] Zoho CRM updated successfully!
    🧹 [req_1760509389324_ocz8clsa4] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000115479503_1760509416357.mp3
    ✅ Request req_1760509389324_ocz8clsa4 completed successfully - Total: 31359ms, Processing: 4612ms
    🔄 Processing request req_1760509412590_6d3kaos80 (waited 8094ms). Active: 5, Queue: 4
    🔧 Processing audio request req_1760509412590_6d3kaos80
    📋 [req_1760509412590_6d3kaos80] Parsed request data: {
      "Call_Record_ID": "5924956000113766323",
      "Call_Recording_URL": "https://play.kaleyra.com/?id=MTUyNTM5NDg2NjY4NDE5Nzk5MjAzNDc3LjI5ODA3Nzh8MTc0OTEyOTExMw==" 
    }
    🎯 [req_1760509412590_6d3kaos80] Processing ID: 5924956000113766323 with URL: https://play.kaleyra.com/?id=MTUyNTM5NDg2NjY4NDE5Nzk5MjAzNDc3LjI5ODA3Nzh8MTc0OTEyOTExMw==
    📥 [req_1760509412590_6d3kaos80] Downloading audio file from: https://play.kaleyra.com/?id=MTUyNTM5NDg2NjY4NDE5Nzk5MjAzNDc3LjI5ODA3Nzh8MTc0OTEyOTExMw==
    🎉 Request req_1760509389324_ocz8clsa4 completed successfully
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000113991163 with transcription...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "b8eb70b8-f3ac-4111-bf36-ccc5dde1558a",
      "client-ip": "136.143.177.62:52696",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.62:52696",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.62",
      "x-client-port": "52696",
      "content-type": "application/json",
      "timestamp": "1760509420850",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000165137570',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=MjA5ODgxNjA4NDY4ZWYzZGM3MTZlZmU1LjczNDg1NTF8MTc2MDUwOTM4Mw=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    📝 [req_1760509410225_ul8n52hvx] Transcription successful. Length: 39 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "1369f51e-6aaf-450f-bc8c-745e77c693e2",
      "client-ip": "136.143.177.61:48832",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.61:48832",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.61",
      "x-client-port": "48832",
      "content-type": "application/json",
      "timestamp": "1760509421052",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000114683260',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=MTU5NzA2MjMyMDY4NDU0Y2IzMjc2MDA0LjE0NTcyMzF8MTc0OTM3MjA4Mw=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:40+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-06T12:37:53+05:30",
            "id": "5924956000113991163",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509387010_ds4qieaqd] Zoho CRM updated successfully!
    🧹 [req_1760509387010_ds4qieaqd] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000113991163_1760509416116.mp3
    ✅ Request req_1760509387010_ds4qieaqd completed successfully - Total: 34427ms, Processing: 8814ms
    🔄 Processing request req_1760509414104_q2fu1dzya (waited 7337ms). Active: 5, Queue: 3
    🔧 Processing audio request req_1760509414104_q2fu1dzya
    📋 [req_1760509414104_q2fu1dzya] Parsed request data: {
      "Call_Record_ID": "5924956000114133818",
      "Call_Recording_URL": "https://play.kaleyra.com/?id=OTMwODQ3NDQwNjg0MmQ3ODQxZmJhNTYuMjI5Njk4OTZ8MTc0OTIxMTAxMg==" 
    }
    🎯 [req_1760509414104_q2fu1dzya] Processing ID: 5924956000114133818 with URL: https://play.kaleyra.com/?id=OTMwODQ3NDQwNjg0MmQ3ODQxZmJhNTYuMjI5Njk4OTZ8MTc0OTIxMTAxMg==
    📥 [req_1760509414104_q2fu1dzya] Downloading audio file from: https://play.kaleyra.com/?id=OTMwODQ3NDQwNjg0MmQ3ODQxZmJhNTYuMjI5Njk4OTZ8MTc0OTIxMTAxMg==
    🎉 Request req_1760509387010_ds4qieaqd completed successfully
    📦 [req_1760509412590_6d3kaos80] Downloaded 16920 bytes
    Detected Content-Type: audio/mpeg
    Using file extension: .mp3
    Audio saved temporarily to: C:\Users\Preopening\Downloads\audio-processor\audio-processor\temp\audio_5924956000113766323_1760509421646.mp3
    🎤 [req_1760509412590_6d3kaos80] Sending audio to OpenAI Whisper for transcription...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "7cb97e37-cfbe-413b-8417-2502f79109e6",
      "client-ip": "136.143.177.61:36736",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.61:36736",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.61",
      "x-client-port": "36736",
      "content-type": "application/json",
      "timestamp": "1760509421989",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000116997205',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=MTI0NTc3ODEwNDY4NTNhM2Q2MDEwYTg0Ljg5MTM2MDR8MTc1MDMxMTg5NA=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "f5c19403-5644-4e05-bc2d-908b1cced7ab",
      "client-ip": "136.143.177.62:53146",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.62:53146",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.62",
      "x-client-port": "53146",
      "content-type": "application/json",
      "timestamp": "1760509422397",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000115072146',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=ODI5MDI5NzgxNjg0N2ZhODE1ZTc3MzkuMzk0Njk1NDB8MTc0OTU0NzY0OQ=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000115719832 with transcription...
    📦 [req_1760509414104_q2fu1dzya] Downloaded 17928 bytes
    Detected Content-Type: audio/mpeg
    Using file extension: .mp3
    Audio saved temporarily to: C:\Users\Preopening\Downloads\audio-processor\audio-processor\temp\audio_5924956000114133818_1760509423324.mp3
    🎤 [req_1760509414104_q2fu1dzya] Sending audio to OpenAI Whisper for transcription...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "099183b1-b802-4fe1-acbb-efc7f22a81fc",
      "client-ip": "136.143.177.61:37150",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.61:37150",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.61",
      "x-client-port": "37150",
      "content-type": "application/json",
      "timestamp": "1760509423117",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000117074224',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=MzIwMjYzODQ0Njg1M2E0MjQyZGY5NTIuODk4OTY0MDZ8MTc1MDMxMTk3Mg=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:43+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-13T10:27:12+05:30",
            "id": "5924956000115719832",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509390220_syygird6j] Zoho CRM updated successfully!
    🧹 [req_1760509390220_syygird6j] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000115719832_1760509418252.mp3
    ✅ Request req_1760509390220_syygird6j completed successfully - Total: 33338ms, Processing: 6629ms
    🔄 Processing request req_1760509415652_celn087fy (waited 7907ms). Active: 5, Queue: 2
    🔧 Processing audio request req_1760509415652_celn087fy
    📋 [req_1760509415652_celn087fy] Parsed request data: {
      "Call_Record_ID": "5924956000114683260",
      "Call_Recording_URL": "https://play.kaleyra.com/?id=MTU5NzA2MjMyMDY4NDU0Y2IzMjc2MDA0LjE0NTcyMzF8MTc0OTM3MjA4Mw==" 
    }
    🎯 [req_1760509415652_celn087fy] Processing ID: 5924956000114683260 with URL: https://play.kaleyra.com/?id=MTU5NzA2MjMyMDY4NDU0Y2IzMjc2MDA0LjE0NTcyMzF8MTc0OTM3MjA4Mw==
    📥 [req_1760509415652_celn087fy] Downloading audio file from: https://play.kaleyra.com/?id=MTU5NzA2MjMyMDY4NDU0Y2IzMjc2MDA0LjE0NTcyMzF8MTc0OTM3MjA4Mw==
    🎉 Request req_1760509390220_syygird6j completed successfully
    📦 [req_1760509415652_celn087fy] Downloaded 14616 bytes
    Detected Content-Type: audio/mpeg
    Using file extension: .mp3
    Audio saved temporarily to: C:\Users\Preopening\Downloads\audio-processor\audio-processor\temp\audio_5924956000114683260_1760509424010.mp3
    🎤 [req_1760509415652_celn087fy] Sending audio to OpenAI Whisper for transcription...
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000113008285 with transcription...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "56b2531c-6940-4b32-bd75-f964382d79c4",
      "client-ip": "136.143.176.64:36968",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.176.64:36968",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.176.64",
      "x-client-port": "36968",
      "content-type": "application/json",
      "timestamp": "1760509423971",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000118509133',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=MTA2MjAyNzE0MzY4NWE4ZTVlYzllNzc3LjU1NjgwNTZ8MTc1MDc2NTE1MA=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    📝 [req_1760509412590_6d3kaos80] Transcription successful. Length: 39 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    📝 [req_1760509414104_q2fu1dzya] Transcription successful. Length: 39 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:44+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-04T09:25:16+05:30",
            "id": "5924956000113008285",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509410225_ul8n52hvx] Zoho CRM updated successfully!
    🧹 [req_1760509410225_ul8n52hvx] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000113008285_1760509418563.mp3
    ✅ Request req_1760509410225_ul8n52hvx completed successfully - Total: 14676ms, Processing: 6896ms
    🔄 Processing request req_1760509416525_571czthsv (waited 8377ms). Active: 5, Queue: 1
    🔧 Processing audio request req_1760509416525_571czthsv
    📋 [req_1760509416525_571czthsv] Parsed request data: {
      "Call_Record_ID": "5924956000115072146",
      "Call_Recording_URL": "https://play.kaleyra.com/?id=ODI5MDI5NzgxNjg0N2ZhODE1ZTc3MzkuMzk0Njk1NDB8MTc0OTU0NzY0OQ==" 
    }
    🎯 [req_1760509416525_571czthsv] Processing ID: 5924956000115072146 with URL: https://play.kaleyra.com/?id=ODI5MDI5NzgxNjg0N2ZhODE1ZTc3MzkuMzk0Njk1NDB8MTc0OTU0NzY0OQ==
    📥 [req_1760509416525_571czthsv] Downloading audio file from: https://play.kaleyra.com/?id=ODI5MDI5NzgxNjg0N2ZhODE1ZTc3MzkuMzk0Njk1NDB8MTc0OTU0NzY0OQ==
    🎉 Request req_1760509410225_ul8n52hvx completed successfully
    📝 [req_1760509391380_61ff2u3dl] Transcription successful. Length: 412 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    📝 [req_1760509415652_celn087fy] Transcription successful. Length: 39 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    === REQUEST DEBUG ===
    Method: POST
    URL: /process-audio
    Content-Type: application/json
    Content-Length: 153
    Headers: {
      "host": "localhost:3000",
      "connection": "keep-alive",
      "user-agent": "https://crm.zoho.com",
      "accept-encoding": "gzip,deflate",
      "cookie": "ARRAffinity=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895; ARRAffinitySameSite=173210037f98080804ded47acc0a5570ba565cfb4c8d063a0644daf2cc148895",
      "max-forwards": "10",
      "x-zoho-crm-feature": "webhook",
      "zsec_user_import_url": "true",
      "x-arr-log-id": "3d5a0fe3-67f3-492e-bbe4-bd0aa57e657e",
      "client-ip": "136.143.177.62:40184",
      "disguised-host": "smee.io",
      "x-site-deployment-id": "smee-io-production",
      "was-default-hostname": "smee-io-production.azurewebsites.net",
      "x-forwarded-proto": "https",
      "x-appservice-proto": "https",
      "x-arr-ssl": "2048|256|CN=GeoTrust Global TLS RSA4096 SHA256 2022 CA1, O=\"DigiCert, Inc.\", C=US|CN=smee.io",    
      "x-forwarded-tlsversion": "1.3",
      "x-forwarded-for": "136.143.177.62:40184",
      "x-original-url": "/TtSEnQAudgDMkYMl",
      "x-waws-unencoded-url": "/TtSEnQAudgDMkYMl",
      "x-client-ip": "136.143.177.62",
      "x-client-port": "40184",
      "content-type": "application/json",
      "timestamp": "1760509424874",
      "accept": "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "content-length": "153"
    }
    Body type: object
    Body content: {
      Call_Record_ID: '5924956000118607290',
      Call_Recording_URL: 'https://play.kaleyra.com/?id=MTQ5NTgwMzgzMjY4NWI4YmQzOGE4NmQ0LjM1NTk3NDR8MTc1MDgzMDAzNQ=='   
    }
    === END REQUEST DEBUG ===
    🚫 Rate limit exceeded for IP: ::1 (20/20)
    📦 [req_1760509416525_571czthsv] Downloaded 17424 bytes
    Detected Content-Type: audio/mpeg
    Using file extension: .mp3
    Audio saved temporarily to: C:\Users\Preopening\Downloads\audio-processor\audio-processor\temp\audio_5924956000115072146_1760509426159.mp3
    🎤 [req_1760509416525_571czthsv] Sending audio to OpenAI Whisper for transcription...
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000113766323 with transcription...
    📝 [req_1760509416525_571czthsv] Transcription successful. Length: 39 characters
    Checking for Zoho access token...
    Token is still valid. Using existing one.
    Generating AI analysis for transcript...
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000165132674 with transcription...
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:46+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-05T18:42:21+05:30",
            "id": "5924956000113766323",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509412590_6d3kaos80] Zoho CRM updated successfully!
    🧹 [req_1760509412590_6d3kaos80] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000113766323_1760509421646.mp3
    ✅ Request req_1760509412590_6d3kaos80 completed successfully - Total: 15103ms, Processing: 7009ms
    🔄 Processing request req_1760509416730_48fvq8h31 (waited 10964ms). Active: 5, Queue: 0
    🔧 Processing audio request req_1760509416730_48fvq8h31
    📋 [req_1760509416730_48fvq8h31] Parsed request data: {
      "Call_Record_ID": "5924956000113008285",
      "Call_Recording_URL": "https://play.kaleyra.com/?id=Nzg1NTM3NDE5NjgzZmMzNzhkNTFmMDAuMjY2NzgyNjF8MTc0OTAwOTI3Mg==" 
    }
    🎯 [req_1760509416730_48fvq8h31] Processing ID: 5924956000113008285 with URL: https://play.kaleyra.com/?id=Nzg1NTM3NDE5NjgzZmMzNzhkNTFmMDAuMjY2NzgyNjF8MTc0OTAwOTI3Mg==
    📥 [req_1760509416730_48fvq8h31] Downloading audio file from: https://play.kaleyra.com/?id=Nzg1NTM3NDE5NjgzZmMzNzhkNTFmMDAuMjY2NzgyNjF8MTc0OTAwOTI3Mg==
    🎉 Request req_1760509412590_6d3kaos80 completed successfully
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000114683260 with transcription...
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:48+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-10-15T11:53:10+05:30",
            "id": "5924956000165132674",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509391380_61ff2u3dl] Zoho CRM updated successfully!
    🧹 [req_1760509391380_61ff2u3dl] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000165132674_1760509418888.wav
    ✅ Request req_1760509391380_61ff2u3dl completed successfully - Total: 37177ms, Processing: 10610ms
    🎉 Request req_1760509391380_61ff2u3dl completed successfully
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:47+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-08T14:12:01+05:30",
            "id": "5924956000114683260",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509415652_celn087fy] Zoho CRM updated successfully!
    🧹 [req_1760509415652_celn087fy] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000114683260_1760509424010.mp3
    ✅ Request req_1760509415652_celn087fy completed successfully - Total: 12937ms, Processing: 5030ms
    🎉 Request req_1760509415652_celn087fy completed successfully
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000114133818 with transcription...
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000115072146 with transcription...
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:49+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-06T17:29:09+05:30",
            "id": "5924956000114133818",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509414104_q2fu1dzya] Zoho CRM updated successfully!
    🧹 [req_1760509414104_q2fu1dzya] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000114133818_1760509423324.mp3
    ✅ Request req_1760509414104_q2fu1dzya completed successfully - Total: 15742ms, Processing: 8405ms
    🎉 Request req_1760509414104_q2fu1dzya completed successfully
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:53:49+05:30",
            "Modified_Time": "2025-10-15T11:53:49+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-10T14:58:14+05:30",
            "id": "5924956000115072146",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509416525_571czthsv] Zoho CRM updated successfully!
    🧹 [req_1760509416525_571czthsv] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-procssor\temp\audio_5924956000115072146_1760509426159.mp3
    essor\temp\audio_5924956000115072146_1760509426159.mp3
    ✅ Request req_1760509416525_571czthsv completed successfully - Total: 13879ms, Processing: 5502ms
    🎉 Request req_1760509416525_571czthsv completed successfully
    📦 [req_1760509416730_48fvq8h31] Downloaded 36432 bytes
    Detected Content-Type: audio/mpeg
    Using file extension: .mp3
    Audio saved temporarily to: C:\Users\Preopening\Downloads\audio-processor\audio-processor\temp\audio_5924956000113008285_1760509438550.mp3
    🎤 [req_1760509416730_48fvq8h31] Sending audio to OpenAI Whisper for transcription...
    📝 [req_1760509416730_48fvq8h31] Transcription successful. Length: 39 characters
    Checking for Zoho access token...        
    Token is still valid. Using existing one.
    Generating AI analysis for transcript... 
    AI analysis generated.
    Updating Zoho CRM module 'Calls' record 5924956000113008285 with transcription...
    Zoho CRM API Response: {
      "data": [
        {
          "code": "SUCCESS",
          "details": {
            "Modified_Time": "2025-10-15T11:54:04+05:30",
            "Modified_By": {
              "name": "Ridhira Tech",
              "id": "5924956000093321198"
            },
            "Created_Time": "2025-06-04T09:25:16+05:30",
            "id": "5924956000113008285",
            "Created_By": {
              "name": "Animesh Deshmukh",
              "id": "5924956000000430001"
            }
          },
          "message": "record updated",
          "status": "success"
        }
      ]
    }
    ✅ [req_1760509416730_48fvq8h31] Zoho CRM updated successfully!
    🧹 [req_1760509416730_48fvq8h31] Temporary file cleaned up: C:\Users\Preopening\Downloads\audio-proc essor\audio-proc
    essor\temp\audio_5924956000113008285_1760509438550.mp3
    ✅ Request req_1760509416730_48fvq8h31 completed successfully - Total: 28059ms, Processing: 17095ms
    🎉 Request req_1760509416730_48fvq8h31 completed successfully
    }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running and listening on http://localhost:${PORT}`);
});
