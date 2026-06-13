
/**
 * VoiceModificationAgent class for voice modification.
 */
class VoiceModificationAgent {
  /**
   * Constructor to initialize the agent with an API key.
   * @param {string} apiKey - The API key for the text-to-speech service.
   */
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * Converts text to speech using Google Cloud Text-to-Speech API.
   * @param {string} text - The text to convert to speech.
   * @param {string} voiceName - The name of the voice to use.
   * @returns {Promise<Buffer>} - A promise that resolves with the audio content as a Buffer.
   */
  async textToSpeech(text, voiceName) {
    if (!text) {
      throw new Error('Input text cannot be empty');
    }

    const url = 'https://texttospeech.googleapis.com/v1/text:synthesize';
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
    const body = {
      input: { text },
      voice: { name: voiceName, languageCode: 'en-US' },
      audioConfig: { audioEncoding: 'MP3' }
    };

    try {
      const response = await axios.post(url, body, { headers });
      return Buffer.from(response.data.audioContent, 'base64');
    } catch (error) {
      console.error('Error converting text to speech:', error);
      throw error;
    }
  }
}

module.exports = VoiceModificationAgent;
