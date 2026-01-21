# Audio Processor Service

This service processes audio recordings by transcribing them using OpenAI Whisper and updating Zoho CRM records.

## Features

- 🎙️ Automatic audio format detection (supports MP3, WAV, M4A, OGG, FLAC, WebM, MP4)
- 🤖 Speech-to-text transcription using OpenAI Whisper API
- 📊 Automatic Zoho CRM record updates
- 🔄 Automatic Zoho OAuth token refresh
- 🧹 Automatic cleanup of temporary files
- 🔗 **Fallback flow**: Automatically fetches recording URLs from Zoho → Knowlarity when not provided in webhook

## Setup

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with the following variables:
```env
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key

# Zoho CRM Configuration
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_DOMAIN=https://www.zohoapis.com
ZOHO_CLIENT_ID=your_client_id
ZOHO_CLIENT_SECRET=your_client_secret
ZOHO_REFRESH_TOKEN=your_refresh_token

# Knowlarity Configuration (required for fallback flow)
KNOWLARITY_BASE_URL=https://kpi.knowlarity.com
KNOWLARITY_API_KEY=your_knowlarity_api_key
KNOWLARITY_AUTH_TOKEN=your_knowlarity_auth_token

# Server Configuration
PORT=3000
```

3. Run the development server:
```bash
npm run dev
```

## How It Works

### Primary Flow (with Call_Recording_URL)
1. Webhook receives `Call_Record_ID` and `Call_Recording_URL`
2. Downloads audio from the provided URL
3. Transcribes using OpenAI Whisper
4. Optionally generates AI analysis
5. Updates Zoho CRM record

### Fallback Flow (without Call_Recording_URL)
When `Call_Recording_URL` is missing:
1. Fetches call record from Zoho CRM using `Call_Record_ID`
2. Extracts UUID from `Voice_Recording__s` field
3. Calls Knowlarity API with UUID to get `secured_recording_url`
4. Continues with transcription and CRM update

## API Endpoints

### POST /process-audio

Processes an audio file from a URL, transcribes it, and updates Zoho CRM.

**Request Body:**
```json
{
  "Call_Record_ID": "5924956000162702001",
  "Call_Recording_URL": "https://example.com/audio.mp3"
}
```

**Note:** `Call_Recording_URL` is optional. If not provided, the service will:
1. Fetch the call record from Zoho CRM using `Call_Record_ID`
2. Extract UUID from `Voice_Recording__s` field
3. Call Knowlarity API to get `secured_recording_url`
4. Use that URL for transcription

**Alternative key names supported:**
- `call_record_id` / `recordId` (instead of `Call_Record_ID`)
- `call_recording_url` / `recordingUrl` (instead of `Call_Recording_URL`)

**Response:**
```json
{
  "message": "Audio transcribed and CRM updated successfully.",
  "recordId": "5924956000162702001",
  "transcript": "The transcribed text...",
  "requestId": "req_1234567890_abc123",
  "processingTime": 15234
}
```

## Azure App Service Deployment

### Prerequisites
- Azure account with an active subscription
- Azure CLI installed (optional, for CLI deployment)

### Deployment Steps

#### Option 1: Deploy via Azure Portal

1. **Create an App Service:**
   - Go to Azure Portal → Create a resource → Web App
   - Choose Node.js as the runtime stack
   - Select appropriate pricing tier

2. **Configure Environment Variables:**
   - Go to your App Service → Configuration → Application settings
   - Add all variables from your `.env` file as Application settings:
     - `OPENAI_API_KEY`
     - `ZOHO_ACCOUNTS_URL`
     - `ZOHO_API_DOMAIN`
     - `ZOHO_CLIENT_ID`
     - `ZOHO_CLIENT_SECRET`
     - `ZOHO_REFRESH_TOKEN`
     - `KNOWLARITY_BASE_URL` (optional, defaults to https://kpi.knowlarity.com)
     - `KNOWLARITY_API_KEY` (required for fallback flow)
     - `KNOWLARITY_AUTH_TOKEN` (required for fallback flow)
     - `PORT` (Azure will set this automatically, but you can override)

3. **Deploy your code:**
   - Use GitHub Actions, Azure DevOps, or FTP deployment
   - Or use VS Code Azure extension

#### Option 2: Deploy via Azure CLI

```bash
# Login to Azure
az login

# Create a resource group
az group create --name audio-processor-rg --location eastus

# Create an App Service plan
az appservice plan create --name audio-processor-plan --resource-group audio-processor-rg --sku B1 --is-linux

# Create the web app
az webapp create --resource-group audio-processor-rg --plan audio-processor-plan --name your-app-name --runtime "NODE|18-lts"

# Configure environment variables
az webapp config appsettings set --resource-group audio-processor-rg --name your-app-name --settings \
  OPENAI_API_KEY="your_key" \
  ZOHO_ACCOUNTS_URL="https://accounts.zoho.com" \
  ZOHO_API_DOMAIN="https://www.zohoapis.com" \
  ZOHO_CLIENT_ID="your_id" \
  ZOHO_CLIENT_SECRET="your_secret" \
  ZOHO_REFRESH_TOKEN="your_token" \
  KNOWLARITY_BASE_URL="https://kpi.knowlarity.com" \
  KNOWLARITY_API_KEY="your_knowlarity_api_key" \
  KNOWLARITY_AUTH_TOKEN="your_knowlarity_auth_token"

# Deploy the code
az webapp up --name your-app-name --resource-group audio-processor-rg
```

### Azure-Specific Notes

1. **File System:** Azure App Service provides a writable temporary file system. The `temp/` directory will be created automatically.

2. **Logging:** View logs in Azure Portal under "Log stream" or use:
```bash
az webapp log tail --name your-app-name --resource-group audio-processor-rg
```

3. **Scaling:** Consider enabling Auto-scaling if you expect high traffic:
   - Go to App Service → Scale up/Scale out
   - Configure based on CPU, memory, or custom metrics

4. **Always On:** Enable "Always On" in App Service Configuration to prevent cold starts:
   - App Service → Configuration → General settings → Always On: On

5. **Health Check:** Configure a health check endpoint:
   - Use the `/hello` endpoint for health checks
   - App Service → Health check → Path: `/hello`

## Troubleshooting

### "Unrecognized file format" Error

The service now automatically detects audio formats using:
1. Content-Type headers
2. URL file extensions
3. File signature detection (magic numbers)

If you still encounter this error, check:
- The audio file is accessible from the URL
- The file is in a supported format
- Network connectivity is working

### OpenAI Quota Exceeded

```
429 You exceeded your current quota
```

**Solution:** Check your OpenAI account at https://platform.openai.com/account/billing and add credits or upgrade your plan.

### Zoho Token Refresh Issues

The service automatically refreshes Zoho tokens. If you encounter errors:
- Verify your `ZOHO_REFRESH_TOKEN` is valid
- Check client ID and secret are correct
- Ensure your Zoho OAuth app has the required scopes

## File Format Support

Supported audio formats:
- MP3 (`.mp3`, `.mpeg`, `.mpga`)
- WAV (`.wav`)
- M4A (`.m4a`)
- MP4 (`.mp4`)
- OGG (`.ogg`, `.oga`)
- FLAC (`.flac`)
- WebM (`.webm`)

## License

ISC

