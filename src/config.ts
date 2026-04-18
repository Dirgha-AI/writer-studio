import 'dotenv/config';

export const config = {
  tts: {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
    cartesiaApiKey: process.env.CARTESIA_API_KEY || '',
  },
  ai: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    groqApiKey: process.env.GROQ_API_KEY || '',
  },
  storage: {
    s3Bucket: process.env.S3_BUCKET || '',
    s3Region: process.env.AWS_REGION || 'us-east-1',
  },
  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || '',
  },
};
