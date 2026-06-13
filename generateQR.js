import QRCode from 'qrcode';

const fileName = 'apex_qr.png';
const text = 'APEX v4 Operational';

QRCode.toFile(fileName, text, {
  type: 'png',
  width: 300,
  errorCorrectionLevel: 'M'
})
  .then(() => {
    console.log(`QR code saved as ${fileName}`);
  })
  .catch((err) => {
    console.error(`Failed to generate QR code: ${err.message}`);
    process.exit(1);
  });