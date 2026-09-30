module.exports = async function handler(req, res) {
  // =========================================================
  // JNI TRAVEL - OCR API
  // OCR Engine: OCR.space
  // =========================================================

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      method: req.method
    });
  }

  try {
    // -------------------------------------------------------
    // 1. CEK API KEY OCR.SPACE
    // -------------------------------------------------------
    const apiKey = process.env.OCR_SPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "OCR_SPACE_API_KEY belum tersedia di Vercel."
      });
    }

    // -------------------------------------------------------
    // 2. AMBIL DATA DARI FRONTEND
    // -------------------------------------------------------
    const {
      documentType,
      fileName,
      mimeType,
      dataUrl
    } = req.body || {};

    if (!dataUrl) {
      return res.status(400).json({
        ok: false,
        error: "File tidak ditemukan."
      });
    }

    // -------------------------------------------------------
    // 3. VALIDASI FILE
    // -------------------------------------------------------
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf"
    ];

    if (mimeType && !allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        ok: false,
        error: `Format file tidak didukung: ${mimeType}`
      });
    }

    // -------------------------------------------------------
    // 4. BATASI UKURAN
    //
    // OCR.space free:
    // file size limit 1 MB
    // -------------------------------------------------------
    const base64Match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);

    if (!base64Match) {
      return res.status(400).json({
        ok: false,
        error: "Format data file tidak valid."
      });
    }

    const detectedMime = base64Match[1];
    const base64Data = base64Match[2];

    // Perkiraan ukuran file dari Base64
    const fileSizeBytes = Math.ceil((base64Data.length * 3) / 4);

    const MAX_BYTES = 1 * 1024 * 1024;

    if (fileSizeBytes > MAX_BYTES) {
      return res.status(400).json({
        ok: false,
        error:
          "Ukuran file lebih dari 1 MB. OCR.space Free memiliki batas file 1 MB."
      });
    }

    // -------------------------------------------------------
    // 5. TENTUKAN FILE TYPE
    // -------------------------------------------------------
    let fileType = "";

    if (detectedMime === "application/pdf") {
      fileType = "PDF";
    } else if (detectedMime === "image/png") {
      fileType = "PNG";
    } else if (
      detectedMime === "image/jpeg" ||
      detectedMime === "image/jpg"
    ) {
      fileType = "JPG";
    } else if (detectedMime === "image/webp") {
      // OCR.space dokumentasi tidak mencantumkan WEBP
      // sebagai format resmi yang didukung.
      return res.status(400).json({
        ok: false,
        error:
          "WEBP belum didukung langsung oleh OCR.space. Gunakan JPG atau PNG."
      });
    }

    // -------------------------------------------------------
    // 6. BUAT REQUEST KE OCR.SPACE
    // -------------------------------------------------------
    const form = new FormData();

    form.append(
      "base64Image",
      `data:${detectedMime};base64,${base64Data}`
    );

    // Auto-detection
    form.append("language", "auto");

    // Engine 2 = balance speed + accuracy
    form.append("OCREngine", "2");

    // Tidak perlu koordinat
    form.append("isOverlayRequired", "false");

    // Auto rotate dokumen
    form.append("detectOrientation", "true");

    // Membantu scan yang resolusinya rendah
    form.append("scale", "true");

    // -------------------------------------------------------
    // 7. PANGGIL OCR.SPACE
    // -------------------------------------------------------
    const ocrResponse = await fetch(
      "https://api.ocr.space/parse/image",
      {
        method: "POST",
        headers: {
          apikey: apiKey
        },
        body: form
      }
    );

    const rawText = await ocrResponse.text();

    let ocrData;

    try {
      ocrData = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "OCR.space mengembalikan response bukan JSON.",
        httpStatus: ocrResponse.status,
        raw: rawText.substring(0, 1000)
      });
    }

    // -------------------------------------------------------
    // 8. CEK ERROR OCR.SPACE
    // -------------------------------------------------------
    if (!ocrResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: "OCR.space API error.",
        httpStatus: ocrResponse.status,
        details: ocrData
      });
    }

    if (ocrData.IsErroredOnProcessing) {
      return res.status(422).json({
        ok: false,
        error:
          ocrData.ErrorMessage ||
          "OCR gagal memproses dokumen.",
        details: ocrData.ErrorDetails || null,
        ocr: ocrData
      });
    }

    // -------------------------------------------------------
    // 9. GABUNGKAN HASIL OCR
    // -------------------------------------------------------
    const parsedResults = Array.isArray(ocrData.ParsedResults)
      ? ocrData.ParsedResults
      : [];

    const text = parsedResults
      .map((item) => item?.ParsedText || "")
      .filter(Boolean)
      .join("\n\n");

    if (!text.trim()) {
      return res.status(422).json({
        ok: false,
        error: "OCR selesai tetapi tidak menemukan teks.",
        documentType: documentType || null,
        fileName: fileName || null,
        ocrExitCode: ocrData.OCRExitCode,
        details: ocrData.ErrorDetails || null
      });
    }

    // -------------------------------------------------------
    // 10. PARSER DASAR JNI
    // -------------------------------------------------------

    const cleanText = text
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();

    // -------------------------
    // NIK
    // -------------------------
    const nikMatches = cleanText.match(/\b\d{16}\b/g) || [];

    const nik =
      nikMatches.length > 0
        ? nikMatches[0]
        : null;

    // -------------------------
    // NOMOR KK
    // -------------------------
    const kkNumber =
      documentType?.toLowerCase() === "kk" && nikMatches.length > 0
        ? nikMatches[0]
        : null;

    // -------------------------
    // PASSPORT
    //
    // Format umum:
    // 1 huruf + 7 angka
    // -------------------------
    const passportMatches =
      cleanText.match(/\b[A-Z]{1}\d{7}\b/gi) || [];

    const passportNumber =
      passportMatches.length > 0
        ? passportMatches[0].toUpperCase()
        : null;

    // -------------------------------------------------------
    // 11. HASIL FINAL
    // -------------------------------------------------------
    return res.status(200).json({
      ok: true,

      fileName: fileName || null,

      documentType: documentType || null,

      data: {
        document_type: documentType || null,

        nama: null,

        nik: nik,

        passport_number: passportNumber,

        tempat_lahir: null,

        tanggal_lahir: null,

        jenis_kelamin: null,

        nationality: null,

        tanggal_terbit: null,

        expiry_date: null,

        alamat: null,

        mrz: null,

        kk_number: kkNumber,

        members: [],

        extraction_notes: []
      },

      // -----------------------------------------------------
      // OCR MENTAH
      //
      // Ini penting untuk tahap berikutnya.
      // Parser JNI bisa kita tingkatkan berdasarkan
      // hasil OCR nyata dari KTP / KK / Passport.
      // -----------------------------------------------------
      rawText: text,

      cleanText: cleanText,

      validation: {
        nik_found: !!nik,
        passport_found: !!passportNumber,
        text_found: true
      },

      ocr: {
        engine: 2,
        exitCode: ocrData.OCRExitCode,
        processingTimeMs:
          ocrData.ProcessingTimeInMilliseconds || null,
        pages: parsedResults.length
      }
    });

  } catch (error) {
    console.error("JNI OCR ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Terjadi error pada server OCR.",
      details: error?.message || String(error)
    });
  }
};
