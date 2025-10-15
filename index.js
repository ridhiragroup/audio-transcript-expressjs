// index.js

const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const multer = require('multer');
require('dotenv').config();

const app = express();

// Enhanced body parsing middleware for Azure Web Apps compatibility
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
app.use(express.text({ type: 'text/plain', limit: '50mb' }));

// Configure multer for multipart/form-data (needed for Zoho form-data)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fieldSize: 50 * 1024 * 1024, // 50MB limit
        fileSize: 50 * 1024 * 1024   // 50MB limit
    }
});

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
app.post('/webhook', upload.none(), async (req, res) => {
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

app.post('/process-audio', upload.none(), async (req, res) => {
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
        
        console.log(`🔍 [${requestId}] Raw request body:`, requestBody);
        console.log(`🔍 [${requestId}] Body type:`, typeof requestBody);
        console.log(`🔍 [${requestId}] Body keys:`, requestBody ? Object.keys(requestBody) : 'null');
        
        // Try to parse request body based on content type
        if (requestBody && typeof requestBody === 'object') {
            // Check if it's form-data (from Zoho)
            if (requestBody.Call_Record_ID && requestBody.Call_Recording_URL) {
                requestData = requestBody;
                console.log(`✅ [${requestId}] Found form-data format with Call_Record_ID and Call_Recording_URL`);
            } else {
                // Try to find the data in different possible locations
                const possibleKeys = ['Call_Record_ID', 'Call_Recording_URL', 'call_record_id', 'call_recording_url', 'recordId', 'recordingUrl'];
                let foundData = {};
                let foundAny = false;
                
                for (const key of possibleKeys) {
                    if (requestBody[key]) {
                        foundData[key] = requestBody[key];
                        foundAny = true;
                    }
                }
                
                if (foundAny) {
                    requestData = foundData;
                    console.log(`✅ [${requestId}] Found data with alternative keys:`, foundData);
                } else {
                    requestData = requestBody;
                    console.log(`⚠️ [${requestId}] Using raw request body as-is:`, requestBody);
                }
            }
        } else if (typeof requestBody === 'string') {
            try {
                requestData = JSON.parse(requestBody);
                console.log(`✅ [${requestId}] Parsed JSON from string body`);
            } catch (parseError) {
                console.log(`🔍 [${requestId}] Failed to parse JSON from string body:`, parseError.message);
                // Try to parse as URL-encoded data
                try {
                    const querystring = require('querystring');
                    requestData = querystring.parse(requestBody);
                    console.log(`✅ [${requestId}] Parsed as URL-encoded data`);
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
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running and listening on http://localhost:${PORT}`);
});
