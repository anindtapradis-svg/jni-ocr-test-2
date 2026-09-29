# JNI OCR Test

Prototype pembaca KTP / Paspor / KK memakai Vercel Serverless Function + Mistral OCR.

## Deploy
1. Upload folder ini ke GitHub.
2. Import repository ke Vercel.
3. Vercel Settings -> Environment Variables.
4. Tambahkan `MISTRAL_API_KEY` berisi API key Mistral.
5. Redeploy.
6. Buka domain Vercel.

## Struktur
- index.html
- api/ocr.js

Tidak ada database dan file tidak disimpan oleh aplikasi ini.
