require('dotenv').config();

const express = require('express');
const multer = require('multer');

const { processAudioRequest } = require('./lib/processAudio');

const app = express();

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
app.use(express.text({ type: 'text/plain', limit: '50mb' }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fieldSize: 50 * 1024 * 1024, fileSize: 50 * 1024 * 1024 },
});

// Debug middleware
app.use((req, res, next) => {
    console.log(`=== REQUEST DEBUG === Method: ${req.method} URL: ${req.url} ===`);
    next();
});

// Routes
app.get('/hello', (req, res) => res.send('Hello World'));

app.get('/health', (req, res) =>
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString(), environment: process.env.NODE_ENV || 'development' })
);


app.post('/process-audio', upload.none(), async (req, res) => {
    console.log('🎯 Received new request to /process-audio');
    console.log("req body", req.body);
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
   
    try {
        const result = await processAudioRequest(req.body, requestId);
        console.log(`🎉 Request ${requestId} completed successfully`);
        res.status(200).json(result);
    } catch (error) {
        console.error(`💥 Request ${requestId} failed:`, error.message);
        res.status(500).json({ error: 'Internal server error', message: error.message, requestId });
    }
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});

server.on('error', (err) => {
    console.error('❌ Server listen error:', err.message);
    if (err.code === 'EADDRINUSE') console.error(`   Port ${PORT} is already in use. Stop the other process or set PORT in .env`);
});

// Log if the process is about to exit (should NOT happen while server is running)
process.on('beforeExit', (code) => {
    console.log(`⚠️ Process about to exit with code ${code} (this usually means something closed the server)`);
});
