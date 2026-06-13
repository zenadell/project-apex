
/**
 * PDF File Summarization Tool
 * @class PdfFileSummarization
 */
class PdfFileSummarization {
  /**
   * Extracts text from a PDF file.
   * @param {string} filePath - The path to the PDF file.
   * @returns {Promise<string>} - A promise that resolves with the extracted text.
   */
  async extractText(filePath) {
    const fs = require('fs');
    const pdf = require('pdf-parse');

    try {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdf(dataBuffer);
      return data.text;
    } catch (error) {
      throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
  }

  /**
   * Summarizes the extracted text.
   * @param {string} text - The extracted text.
   * @returns {Promise<string>} - A promise that resolves with the summarized text.
   */
  async summarizeText(text) {
    const { pipeline } = require('stream');
    const { TextRankSummarizer } = require('natural');

    try {
      const summarizer = new TextRankSummarizer();
      const summary = summarizer.summarize(text, 3);
      return summary.join('\n');
    } catch (error) {
      throw new Error(`Failed to summarize text: ${error.message}`);
    }
  }

  /**
   * Summarizes a PDF file.
   * @param {string} filePath - The path to the PDF file.
   * @returns {Promise<string>} - A promise that resolves with the summarized text.
   */
  async summarizePdf(filePath) {
    try {
      const text = await this.extractText(filePath);
      const summary = await this.summarizeText(text);
      return summary;
    } catch (error) {
      throw new Error(`Failed to summarize PDF: ${error.message}`);
    }
  }
}

module.exports = PdfFileSummarization;
