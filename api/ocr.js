const MAX_BYTES = 2500000;

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
];

function sendJSON(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function validNIK(nik) {
  return typeof nik === "string" && /^\d{16}$/.test(nik);
}

function validPassport(number) {
  if (!number) return false;

  return /^[A-Z0-9]{7,12}$/.test(
    String(number)
      .toUpperCase()
      .replace(/\s/g, "")
  );
}

function checkMRZDigit(value) {
  const weights = [7, 3, 1];

  let sum = 0;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    let number;

    if (char >= "0" && char <= "9") {
      number = Number(char);
    } else if (char >= "A" && char <= "Z") {
      number = char.charCodeAt(0) - 55;
    } else {
      number = 0;
    }

    sum += number * weights[i % 3];
  }

  return String(sum % 10);
}

function validate(data, requestedType) {
  const checks = [];

  checks.push({
    ok:
      data.document_type === requestedType ||
      requestedType === "OTHER",

    message:
      "Jenis dokumen terbaca: " +
      (data.document_type || "tidak diketahui")
  });

  if (data.document_type === "KTP") {
    checks.push({
      ok: validNIK(data.nik),

      message: validNIK(data.nik)
        ? "NIK terdiri dari 16 digit."
        : "NIK tidak terbaca sebagai 16 digit."
    });
  }

  if (data.document_type === "PASSPORT") {
    checks.push({
      ok: validPassport(data.passport_number),

      message: validPassport(data.passport_number)
        ? "Format nomor paspor terlihat wajar."
        : "Nomor paspor perlu diperiksa."
    });

    const lines = String(data.mrz || "")
      .split(/\r?\n/)
      .map(x => x.replace(/\s/g, ""))
      .filter(Boolean);

    if (
      lines.length >= 2 &&
      lines[1].length >= 10 &&
      data.passport_number
    ) {
      const line2 = lines[1];

      const mrzNumber =
        line2
          .slice(0, 9)
          .replace(/</g, "");

      const checkDigit =
        line2[9];

      const expected =
        checkMRZDigit(
          line2.slice(0, 9)
        );

      const match =
        mrzNumber ===
          String(data.passport_number)
            .toUpperCase()
            .replace(/\s/g, "") &&
        checkDigit === expected;

      checks.push({
        ok: match,

        message: match
          ? "Nomor paspor cocok dengan MRZ."
          : "Nomor paspor tidak cocok dengan MRZ."
      });

    } else {

      checks.push({
        ok: false,
        message:
          "MRZ tidak terbaca lengkap. Perlu pemeriksaan manual."
      });

    }
  }

  return {
    status:
      checks.some(x => !x.ok)
        ? "REVIEW"
        : "VALID",

    checks
  };
}

function getSchema() {
  return {
    type: "object",

    properties: {

      document_type: {
        type: "string",
        enum: [
          "KTP",
          "PASSPORT",
          "KK",
          "OTHER"
        ]
      },

      nama: {
        type: ["string", "null"]
      },

      nik: {
        type: ["string", "null"]
      },

      passport_number: {
        type: ["string", "null"]
      },

      tempat_lahir: {
        type: ["string", "null"]
      },

      tanggal_lahir: {
        type: ["string", "null"]
      },

      jenis_kelamin: {
        type: ["string", "null"]
      },

      nationality: {
        type: ["string", "null"]
      },

      tanggal_terbit: {
        type: ["string", "null"]
      },

      expiry_date: {
        type: ["string", "null"]
      },

      alamat: {
        type: ["string", "null"]
      },

      mrz: {
        type: ["string", "null"]
      },

      kk_number: {
        type: ["string", "null"]
      },

      members: {
        type: "array",

        items: {
          type: "object",

          properties: {

            nama: {
              type: ["string", "null"]
            },

            nik: {
              type: ["string", "null"]
            },

            tanggal_lahir: {
              type: ["string", "null"]
            },

            hubungan: {
              type: ["string", "null"]
            }

          },

          required: [
            "nama",
            "nik",
            "tanggal_lahir",
            "hubungan"
          ],

          additionalProperties: false
        }
      },

      extraction_notes: {
        type: "string"
      }

    },

    required: [
      "document_type",
      "nama",
      "nik",
      "passport_number",
      "tempat_lahir",
      "tanggal_lahir",
      "jenis_kelamin",
      "nationality",
      "tanggal_terbit",
      "expiry_date",
      "alamat",
      "mrz",
      "kk_number",
      "members",
      "extraction_notes"
    ],

    additionalProperties: false
  };
}


module.exports = async function handler(req, res) {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );


  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }


  if (req.method !== "POST") {
    return sendJSON(
      res,
      405,
      {
        error: "Method not allowed",
        method: req.method
      }
    );
  }


  try {

    if (!process.env.MISTRAL_API_KEY) {

      return sendJSON(
        res,
        500,
        {
          error:
            "MISTRAL_API_KEY belum tersedia di Vercel."
        }
      );

    }


    const body = req.body || {};

    const {
      documentType,
      fileName,
      mimeType,
      dataUrl
    } = body;


    if (!dataUrl) {

      return sendJSON(
        res,
        400,
        {
          error:
            "dataUrl file tidak ditemukan."
        }
      );

    }


    if (!mimeType) {

      return sendJSON(
        res,
        400,
        {
          error:
            "mimeType file tidak ditemukan."
        }
      );

    }


    if (
      !ALLOWED_TYPES.includes(
        mimeType
      )
    ) {

      return sendJSON(
        res,
        400,
        {
          error:
            "Format file tidak didukung.",
          received:
            mimeType
        }
      );

    }


    const base64 =
      String(dataUrl)
        .split(",")[1] || "";


    const estimatedSize =
      Math.floor(
        base64.length * 0.75
      );


    if (
      estimatedSize >
      MAX_BYTES
    ) {

      return sendJSON(
        res,
        413,
        {
          error:
            "Ukuran file maksimal 2,5 MB untuk prototype."
        }
      );

    }


    let document;


    if (
      mimeType ===
      "application/pdf"
    ) {

      document = {
        type: "document_url",
        document_url: dataUrl
      };

    } else {

      document = {
        type: "image_url",
        image_url: dataUrl
      };

    }


    const payload = {

      model:
        "mistral-ocr-latest",

      document,

      document_annotation_format: {

        type:
          "json_schema",

        json_schema: {

          name:
            "jni_identity_document",

          schema:
            getSchema(),

          strict:
            true

        }

      },

      document_annotation_prompt: `

Kamu adalah sistem OCR dokumen JNI Travel.

Jenis dokumen:
${documentType}

Baca HANYA informasi yang benar-benar terlihat.

Jangan mengarang.
Jangan menebak karakter yang tidak terbaca.

Jika suatu informasi tidak terlihat jelas,
isi null.

Untuk KTP:
- NIK
- nama lengkap
- tempat lahir
- tanggal lahir
- jenis kelamin
- alamat

Untuk PASPOR:
- nomor paspor
- nama
- kewarganegaraan
- jenis kelamin
- tanggal lahir
- tanggal terbit
- tanggal expired
- MRZ lengkap

Untuk KK:
- nomor KK
- seluruh anggota keluarga
- NIK
- nama
- tanggal lahir
- hubungan keluarga

Gunakan format tanggal YYYY-MM-DD
jika tanggal dapat dibaca dengan jelas.

`

    };


    const mistralResponse =
      await fetch(
        "https://api.mistral.ai/v1/ocr",
        {

          method:
            "POST",

          headers: {

            "Authorization":
              "Bearer " +
              process.env.MISTRAL_API_KEY,

            "Content-Type":
              "application/json"

          },

          body:
            JSON.stringify(
              payload
            )

        }
      );


    const mistralText =
      await mistralResponse.text();


    let mistralData;


    try {

      mistralData =
        JSON.parse(
          mistralText
        );

    } catch {

      return sendJSON(
        res,
        502,
        {

          error:
            "Mistral mengembalikan response bukan JSON.",

          httpStatus:
            mistralResponse.status,

          response:
            mistralText.substring(
              0,
              1000
            )

        }
      );

    }


    if (
      !mistralResponse.ok
    ) {

      return sendJSON(
        res,
        mistralResponse.status,
        {

          error:
            mistralData.message ||
            mistralData.error ||
            "Mistral OCR gagal.",

          mistral:
            mistralData

        }
      );

    }


    let data =
      mistralData
        .document_annotation;


    if (
      typeof data ===
      "string"
    ) {

      try {

        data =
          JSON.parse(
            data
          );

      } catch {

        return sendJSON(
          res,
          502,
          {

            error:
              "document_annotation dari Mistral bukan JSON.",

            raw:
              data

          }
        );

      }

    }


    if (
      !data ||
      typeof data !==
      "object"
    ) {

      return sendJSON(
        res,
        502,
        {

          error:
            "Mistral tidak mengembalikan hasil ekstraksi."

        }
      );

    }


    return sendJSON(
      res,
      200,
      {

        ok:
          true,

        fileName:
          fileName || null,

        data,

        validation:
          validate(
            data,
            documentType
          ),

        usage:
          mistralData.usage_info ||
          null

      }
    );


  } catch (error) {

    console.error(
      "JNI OCR ERROR:",
      error
    );

    return sendJSON(
      res,
      500,
      {

        error:
          error.message ||
          "Internal server error."

      }
    );

  }

};
