// api/ocr.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      method: req.method,
    });
  }

  try {
    const apiKey = process.env.OCR_SPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "OCR_SPACE_API_KEY belum dikonfigurasi di Vercel.",
      });
    }

    const {
      documentType,
      fileName,
      mimeType,
      dataUrl,
    } = req.body || {};

    if (!dataUrl) {
      return res.status(400).json({
        ok: false,
        error: "File tidak ditemukan.",
      });
    }

    const allowedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];

    if (mimeType && !allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        ok: false,
        error: "Format file tidak didukung.",
      });
    }

    /*
    ============================================================
    1. BASE64
    ============================================================
    */

    const base64Image = dataUrl.includes(",")
      ? dataUrl.split(",")[1]
      : dataUrl;

    if (!base64Image) {
      return res.status(400).json({
        ok: false,
        error: "Data file kosong.",
      });
    }

    /*
    ============================================================
    2. OCR.SPACE
    ============================================================
    */

    const form = new FormData();

    form.append(
      "base64Image",
      `data:${mimeType || "image/jpeg"};base64,${base64Image}`
    );

    form.append("apikey", apiKey);

    /*
     * ENGINE 2 DIPERTAHANKAN.
     * Jangan ganti ke Engine 3 dulu karena KTP sudah bagus.
     */
    form.append("OCREngine", "2");

    form.append("language", "auto");
    form.append("isOverlayRequired", "true");
    form.append("detectOrientation", "true");
    form.append("scale", "true");

    if (String(documentType).toLowerCase() === "kk") {
      form.append("isTable", "true");
    } else {
      form.append("isTable", "false");
    }

    form.append(
      "filetype",
      mimeType === "application/pdf" ? "PDF" : "JPG"
    );

    const response = await fetch(
      "https://api.ocr.space/parse/image",
      {
        method: "POST",
        body: form,
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: `OCR provider HTTP ${response.status}`,
      });
    }

    const ocr = await response.json();

    if (ocr.IsErroredOnProcessing) {
      return res.status(422).json({
        ok: false,
        error:
          ocr.ErrorMessage?.join?.(" ") ||
          ocr.ErrorMessage ||
          "OCR gagal diproses.",
        ocr,
      });
    }

    /*
    ============================================================
    3. RAW TEXT
    ============================================================
    */

    const parsedResults = Array.isArray(ocr.ParsedResults)
      ? ocr.ParsedResults
      : [];

    const rawText = parsedResults
      .map((x) => x?.ParsedText || "")
      .join("\n")
      .replace(/\r/g, "")
      .trim();

    /*
    ============================================================
    4. OVERLAY WORDS
    ============================================================
    */

    const overlayWords = [];

    for (const page of parsedResults) {
      const lines = page?.TextOverlay?.Lines || [];

      for (const line of lines) {
        const words = Array.isArray(line?.Words)
          ? line.Words
          : [];

        for (const word of words) {
          if (!word?.WordText) continue;

          const left = Number(word.Left || 0);
          const top = Number(word.Top || 0);
          const width = Number(word.Width || 0);
          const height = Number(word.Height || 0);

          overlayWords.push({
            text: String(word.WordText).trim(),
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
            centerX: left + width / 2,
            centerY: top + height / 2,
          });
        }
      }
    }

    /*
    ============================================================
    5. NORMALIZATION
    ============================================================
    */

    function cleanText(value) {
      if (value == null) return null;

      const v = String(value)
        .replace(/\s+/g, " ")
        .trim();

      return v || null;
    }

    function upper(value) {
      return cleanText(value)?.toUpperCase() || "";
    }

    function linesFromText(text) {
      return String(text || "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
    }

    const textLines = linesFromText(rawText);

    function normalizeOCRText(value) {
      return upper(value)
        .replace(/[“”"']/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    /*
    ============================================================
    6. DATE
    ============================================================
    */

    const MONTHS = {
      JAN: "JAN",
      JANUARY: "JAN",
      FEB: "FEB",
      FEBRUARY: "FEB",
      MAR: "MAR",
      MARCH: "MAR",
      APR: "APR",
      APRIL: "APR",
      MAY: "MAY",
      JUN: "JUN",
      JUNE: "JUN",
      JUL: "JUL",
      JULY: "JUL",
      AUG: "AUG",
      AUGUST: "AUG",
      SEP: "SEP",
      SEPT: "SEP",
      SEPTEMBER: "SEP",
      OCT: "OCT",
      OCTOBER: "OCT",
      NOV: "NOV",
      NOVEMBER: "NOV",
      DEC: "DEC",
      DECEMBER: "DEC",
    };

    const MONTH_LIST = [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ];

    function normalizeDate(value) {
      if (!value) return null;

      let v = upper(value)
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      let m = v.match(
        /\b(\d{1,2})\s+([A-Z]{3,9})\s+(\d{4})\b/
      );

      if (m) {
        const month = MONTHS[m[2]];

        if (month) {
          return `${String(m[1]).padStart(2, "0")} ${month} ${m[3]}`;
        }
      }

      m = v.match(
        /\b(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{4})\b/
      );

      if (m) {
        const month = Number(m[2]);

        if (month >= 1 && month <= 12) {
          return `${String(m[1]).padStart(2, "0")} ${
            MONTH_LIST[month - 1]
          } ${m[3]}`;
        }
      }

      return null;
    }

    function findDates(value) {
      if (!value) return [];

      const text = upper(value)
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ");

      const results = [];

      const monthRegex =
        /\b\d{1,2}\s+(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\s+\d{4}\b/g;

      for (const m of text.matchAll(monthRegex)) {
        const d = normalizeDate(m[0]);
        if (d) results.push(d);
      }

      const numericRegex =
        /\b\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{4}\b/g;

      for (const m of text.matchAll(numericRegex)) {
        const d = normalizeDate(m[0]);
        if (d) results.push(d);
      }

      return [...new Set(results)];
    }

    function isDate(value) {
      return !!normalizeDate(value);
    }

    /*
    ============================================================
    7. LABEL CHECK
    ============================================================
    */

    function isLabelOnly(value) {
      const v = normalizeOCRText(value);

      if (!v) return true;

      const labels = [
        "NAME",
        "NAMA",
        "SURNAME",
        "GIVEN NAMES",
        "GIVEN NAME",
        "NATIONALITY",
        "DATE OF BIRTH",
        "TANGGAL LAHIR",
        "PLACE OF BIRTH",
        "TEMPAT LAHIR",
        "SEX",
        "GENDER",
        "JENIS KELAMIN",
        "DATE OF ISSUE",
        "DATE OF ISSUANCE",
        "TANGGAL TERBIT",
        "DATE OF EXPIRY",
        "DATE OF EXPIRATION",
        "EXPIRY DATE",
        "TANGGAL EXPIRED",
        "ISSUING AUTHORITY",
        "ISSUING OFFICE",
        "AUTHORITY",
        "KANTOR",
        "PASSPORT",
        "PASPOR",
        "NIK",
        "ALAMAT",
        "RT/RW",
        "KELURAHAN",
        "DESA",
        "KECAMATAN",
      ];

      return labels.some(
        (label) =>
          v === label ||
          v === `${label}:` ||
          v === `${label} -` ||
          v === `/${label}` ||
          v === `/ ${label}` ||
          v.endsWith(` ${label}`)
      );
    }

    /*
    ============================================================
    8. GENERIC VALUE AFTER LABEL
    ============================================================
    */

    function valueAfterLabel(
      lines,
      labels,
      validator = null
    ) {
      const normalizedLabels = labels.map(normalizeOCRText);

      for (let i = 0; i < lines.length; i++) {
        const original = lines[i];
        const current = normalizeOCRText(original);

        for (const label of normalizedLabels) {
          if (!label) continue;

          /*
           * LABEL : VALUE
           */
          if (current.startsWith(label + " ")) {
            let remainder = original
              .slice(
                original
                  .toUpperCase()
                  .indexOf(label) + label.length
              )
              .trim();

            remainder = remainder
              .replace(/^[:\-\/]+/, "")
              .trim();

            if (
              remainder &&
              !isLabelOnly(remainder) &&
              (!validator || validator(remainder))
            ) {
              return cleanText(remainder);
            }
          }

          /*
           * LABEL saja → ambil baris berikutnya
           */
          if (
            current === label ||
            current.replace(/[:\-]/g, "").trim() === label
          ) {
            for (
              let j = i + 1;
              j <= Math.min(i + 3, lines.length - 1);
              j++
            ) {
              const candidate = cleanText(lines[j]);

              if (!candidate) continue;
              if (isLabelOnly(candidate)) continue;

              if (
                validator &&
                !validator(candidate)
              ) {
                continue;
              }

              return candidate;
            }
          }
        }
      }

      return null;
    }

    /*
    ============================================================
    9. KTP
    ============================================================
    */

    function parseNIK(text) {
      const matches =
        String(text || "").match(/\b\d{16}\b/g);

      if (!matches) return null;

      for (const nik of matches) {
        const firstTwo = Number(nik.slice(0, 2));
        const city = Number(nik.slice(0, 6));
        const month = Number(nik.slice(8, 10));
        let day = Number(nik.slice(6, 8));

        if (day > 40) day -= 40;

        if (
          firstTwo >= 11 &&
          firstTwo <= 99 &&
          city >= 110000 &&
          month >= 1 &&
          month <= 12 &&
          day >= 1 &&
          day <= 31
        ) {
          return nik;
        }
      }

      return matches[0];
    }

    function normalizeGender(value) {
      const v = upper(value);

      if (!v) return null;

      if (
        v.includes("LAKI") ||
        v === "L" ||
        v === "MALE" ||
        v === "M"
      ) {
        return "LAKI-LAKI";
      }

      if (
        v.includes("PEREMPUAN") ||
        v.includes("WANITA") ||
        v === "P" ||
        v === "F" ||
        v === "FEMALE"
      ) {
        return "PEREMPUAN";
      }

      return cleanText(value);
    }

    function extractKTPBirth(line) {
      if (!line) return null;

      let value = cleanText(line);

      value = value.replace(
        /^\s*(TEMPAT\/?TGL\.?\s*LAHIR|TEMPAT\s+TGL\s+LAHIR|TEMPAT\s+LAHIR|TTL)\s*[:\-]?\s*/i,
        ""
      );

      value = cleanText(value);

      if (!value) return null;

      const dates = findDates(value);

      if (!dates.length) return null;

      const date = dates[0];

      let place = value
        .replace(
          /\b\d{1,2}\s+(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\s+\d{4}\b/gi,
          ""
        )
        .replace(
          /\b\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{4}\b/g,
          ""
        )
        .replace(/\s{2,}/g, " ")
        .replace(/^[,;:\-]+|[,;:\-]+$/g, "")
        .trim();

      if (!place || isLabelOnly(place)) {
        place = null;
      }

      return {
        tempat_lahir: place,
        tanggal_lahir: date,
      };
    }

    function parseKTP(text) {
      const lines = linesFromText(text);

      const result = {
        nik: parseNIK(text),
        nama: null,
        tempat_lahir: null,
        tanggal_lahir: null,
        jenis_kelamin: null,
        alamat: null,
        rt_rw: null,
        kelurahan_desa: null,
        kecamatan: null,
        status_perkawinan: null,
        pekerjaan: null,
        kewarganegaraan: null,
      };

      result.nama = valueAfterLabel(lines, ["NAMA"]);

      /*
       * TTL
       */
      for (let i = 0; i < lines.length; i++) {
        const normalized = normalizeOCRText(lines[i]);

        if (
          normalized.includes("TEMPAT") &&
          normalized.includes("LAHIR")
        ) {
          const ttl = extractKTPBirth(lines[i]);

          if (ttl) {
            result.tempat_lahir = ttl.tempat_lahir;
            result.tanggal_lahir = ttl.tanggal_lahir;
            break;
          }

          for (
            let j = i + 1;
            j <= Math.min(i + 2, lines.length - 1);
            j++
          ) {
            const ttlNext = extractKTPBirth(lines[j]);

            if (ttlNext) {
              result.tempat_lahir = ttlNext.tempat_lahir;
              result.tanggal_lahir = ttlNext.tanggal_lahir;
              break;
            }
          }
        }
      }

      if (!result.tanggal_lahir) {
        for (const line of lines) {
          const dates = findDates(line);

          if (!dates.length) continue;

          const normalized = normalizeOCRText(line);

          if (
            normalized.includes("BERLAKU") ||
            normalized.includes("HINGGA") ||
            normalized.includes("TERBIT")
          ) {
            continue;
          }

          const ttl = extractKTPBirth(line);

          if (ttl?.tanggal_lahir) {
            result.tanggal_lahir = ttl.tanggal_lahir;
            result.tempat_lahir = ttl.tempat_lahir;
            break;
          }
        }
      }

      result.jenis_kelamin = normalizeGender(
        valueAfterLabel(lines, ["JENIS KELAMIN"])
      );

      result.alamat = valueAfterLabel(
        lines,
        ["ALAMAT"]
      );

      /*
       * RT/RW
       */
      for (const line of lines) {
        const m = line.match(
          /\b(\d{1,3})\s*[/\-]\s*(\d{1,3})\b/
        );

        if (m) {
          result.rt_rw = `${m[1].padStart(
            3,
            "0"
          )}/${m[2].padStart(3, "0")}`;

          break;
        }
      }

      if (!result.rt_rw) {
        result.rt_rw = valueAfterLabel(
          lines,
          ["RT/RW", "RT RW"]
        );
      }

      result.kelurahan_desa = valueAfterLabel(
        lines,
        [
          "KELURAHAN/DESA",
          "KELURAHAN",
          "DESA",
        ]
      );

      result.kecamatan = valueAfterLabel(
        lines,
        ["KECAMATAN"]
      );

      result.status_perkawinan = valueAfterLabel(
        lines,
        [
          "STATUS PERKAWINAN",
          "STATUS PERKAWINAN MENURUT",
        ]
      );

      result.pekerjaan = valueAfterLabel(
        lines,
        ["PEKERJAAN"]
      );

      result.kewarganegaraan = valueAfterLabel(
        lines,
        ["KEWARGANEGARAAN"]
      );

      return result;
    }

    /*
    ============================================================
    10. PASSPORT HELPERS
    ============================================================
    */

    function isPassportNumber(value) {
      if (!value) return false;

      const v = upper(value)
        .replace(/[^A-Z0-9]/g, "");

      if (
        v === "PASSPORT" ||
        v === "PASSPORI" ||
        v === "PASPOR"
      ) {
        return false;
      }

      return (
        /^[A-Z][0-9]{7}$/.test(v) ||
        /^[A-Z0-9]{7,9}$/.test(v)
      );
    }

    function normalizePassportNumber(value) {
      if (!value) return null;

      const v = upper(value)
        .replace(/[^A-Z0-9]/g, "");

      return isPassportNumber(v) ? v : null;
    }

    function isNationality(value) {
      if (!value) return false;

      const v = upper(value);

      if (isDate(v)) return false;

      if (
        v.includes("PLACE OF") ||
        v.includes("DATE OF") ||
        v.includes("BIRTH") ||
        v.includes("ISSUE") ||
        v.includes("EXPIR") ||
        v.includes("AUTHORITY") ||
        v.includes("OFFICE") ||
        v.includes("PASSPORT") ||
        v.includes("NAME") ||
        v.includes("DIATUR") ||
        v.includes("UNDANG")
      ) {
        return false;
      }

      const valid = [
        "INDONESIAN",
        "INDONESIA",
        "IDN",
        "WNI",
        "MALAYSIAN",
        "MALAYSIA",
        "MYS",
        "SINGAPOREAN",
        "SINGAPORE",
        "SGP",
      ];

      if (valid.includes(v)) return true;

      return /^[A-Z]{3}$/.test(v);
    }

    function normalizeNationality(value) {
      if (!value) return null;

      const v = upper(value);

      if (
        v === "IDN" ||
        v === "INDONESIA" ||
        v === "INDONESIAN" ||
        v === "WNI"
      ) {
        return "INDONESIAN";
      }

      return cleanText(value);
    }

    function normalizeSex(value) {
      if (!value) return null;

      const v = upper(value)
        .replace(/[.:;\/\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (
        v === "M" ||
        v === "MALE"
      ) {
        return "M";
      }

      if (
        v === "F" ||
        v === "FEMALE"
      ) {
        return "F";
      }

      return null;
    }

    function isPassportName(value) {
      if (!value) return false;

      const v = upper(value)
        .replace(/\s+/g, " ")
        .trim();

      if (v.length < 3 || v.length > 80) {
        return false;
      }

      if (
        isDate(v) ||
        isLabelOnly(v) ||
        v.includes("PLACE OF") ||
        v.includes("DATE OF") ||
        v.includes("NATIONALITY") ||
        v.includes("ISSUING")
      ) {
        return false;
      }

      return /[A-Z]{2,}/.test(v);
    }

    /*
    ============================================================
    11. PLACE OF BIRTH
    ============================================================
    */

    function isPassportPlace(value) {
      if (!value) return false;

      const v = upper(value)
        .replace(/\s+/g, " ")
        .trim();

      if (!v) return false;

      /*
       * INI KUNCI PERBAIKAN.
       *
       * Semua variasi label ini HARUS DITOLAK.
       */
      const forbidden = [
        "PLACE OF BIRTH",
        "/ PLACE OF BIRTH",
        "PLACE OF",
        "BIRTH",
        "TEMPAT LAHIR",
        "/ TEMPAT LAHIR",
        "DATE OF BIRTH",
        "DATE OF",
        "NATIONALITY",
        "ISSUING AUTHORITY",
        "ISSUING OFFICE",
      ];

      if (
        forbidden.some(
          (x) =>
            v === x ||
            v.includes(x)
        )
      ) {
        return false;
      }

      if (isDate(v)) return false;

      if (v.length < 2 || v.length > 80) {
        return false;
      }

      return true;
    }

    /*
    ============================================================
    12. MRZ
    ============================================================
    */

    function cleanMRZLine(value) {
      if (!value) return null;

      let v = upper(value)
        .replace(/\s+/g, "")
        .replace(/[«‹]/g, "<")
        .replace(/[|]/g, "I")
        .trim();

      if (v.length < 25) return null;

      v = v.replace(/[^A-Z0-9<]/g, "");

      if (v.length < 25) return null;

      return v;
    }

    function looksLikeMRZ(value) {
      const v = cleanMRZLine(value);

      if (!v) return false;

      return (
        v.length >= 30 &&
        (
          v.includes("<") ||
          /^P[A-Z0-9<]/.test(v) ||
          /^[A-Z0-9]{7,9}[<]/.test(v)
        )
      );
    }

    /*
     * OCR kadang membaca:
     *
     * E1623717<5IDN...
     *
     * padahal posisi standar:
     *
     * E1623717<IDN...
     *
     * Karakter ke-10 adalah filler.
     *
     * Jadi parser harus toleran terhadap satu karakter
     * ekstra di antara nomor passport dan nationality.
     */

    function parseMRZDate(raw, type) {
      if (!raw || !/^\d{6}$/.test(raw)) {
        return null;
      }

      const yy = Number(raw.slice(0, 2));
      const mm = Number(raw.slice(2, 4));
      const dd = Number(raw.slice(4, 6));

      if (
        mm < 1 ||
        mm > 12 ||
        dd < 1 ||
        dd > 31
      ) {
        return null;
      }

      let year;

      if (type === "expiry") {
        /*
         * Passport modern.
         * 33 => 2033
         */
        year = 2000 + yy;
      } else {
        /*
         * DOB:
         * pilih century berdasarkan umur masuk akal.
         */
        const currentYear =
          new Date().getFullYear();

        const candidate2000 = 2000 + yy;
        const age2000 =
          currentYear - candidate2000;

        if (
          age2000 >= 0 &&
          age2000 <= 120
        ) {
          year = candidate2000;
        } else {
          year = 1900 + yy;
        }
      }

      return `${String(dd).padStart(
        2,
        "0"
      )} ${
        MONTH_LIST[mm - 1]
      } ${year}`;
    }

    function parseMRZ(text) {
      const lines = linesFromText(text);

      const candidates = lines
        .map(cleanMRZLine)
        .filter(Boolean);

      let first = null;
      let second = null;

      /*
       * Cari line passport MRZ pertama.
       */
      for (const candidate of candidates) {
        if (
          candidate.length >= 40 &&
          /^P[A-Z0-9<]/.test(candidate)
        ) {
          first = candidate;
          break;
        }
      }

      /*
       * Cari line kedua:
       * biasanya diawali passport number.
       */
      for (const candidate of candidates) {
        if (candidate === first) continue;

        if (
          candidate.length >= 35 &&
          /\d{6}/.test(candidate) &&
          /[MF]/.test(candidate)
        ) {
          second = candidate;
          break;
        }
      }

      /*
       * Kalau format OCR tidak sempurna,
       * pilih dua kandidat terpanjang.
       */
      if (!first || !second) {
        const longCandidates =
          candidates
            .filter((x) => x.length >= 35)
            .sort(
              (a, b) => b.length - a.length
            );

        if (!first && longCandidates.length) {
          first = longCandidates[0];
        }

        if (!second) {
          second =
            longCandidates.find(
              (x) => x !== first
            ) || null;
        }
      }

      if (!second) {
        return {
          raw: first || null,
          passport_number: null,
          nationality: null,
          date_of_birth: null,
          sex: null,
          date_of_expiry: null,
          surname: null,
          given_names: null,
        };
      }

      /*
       * Normalisasi panjang.
       */
      const line2 = second
        .padEnd(44, "<")
        .slice(0, 44);

      /*
       * ========================================================
       * STANDARD TD3
       *
       * 0-8   passport number
       * 9     filler
       * 10-12 nationality
       * 13-18 DOB
       * 19    check
       * 20    sex
       * 21-26 expiry
       * ========================================================
       */

      let passportNumber =
        line2
          .slice(0, 9)
          .replace(/</g, "");

      /*
       * OCR kadang menambahkan satu karakter:
       *
       * E1623717<5IDN...
       *
       * sehingga posisi nationality bergeser.
       *
       * Cek dua kemungkinan.
       */

      let nationality = null;
      let dobRaw = null;
      let sex = null;
      let expiryRaw = null;

      const standardNationality =
        line2.slice(10, 13);

      const standardDob =
        line2.slice(13, 19);

      const standardSex =
        line2.slice(20, 21);

      const standardExpiry =
        line2.slice(21, 27);

      if (
        /^[A-Z]{3}$/.test(
          standardNationality
        )
      ) {
        nationality =
          standardNationality;

        dobRaw = standardDob;
        sex = standardSex;
        expiryRaw = standardExpiry;
      } else {
        /*
         * Shifted OCR variant.
         *
         * E1623717<5IDN8307118M330209...
         */
        const shiftedNationality =
          line2.slice(11, 14);

        if (
          /^[A-Z]{3}$/.test(
            shiftedNationality
          )
        ) {
          nationality =
            shiftedNationality;

          dobRaw =
            line2.slice(14, 20);

          sex =
            line2.slice(21, 22);

          expiryRaw =
            line2.slice(22, 28);
        }
      }

      /*
       * Kalau sex masih belum dapat,
       * cari M/F setelah DOB.
       */
      if (
        sex !== "M" &&
        sex !== "F"
      ) {
        const sexMatch =
          line2.match(
            /\d{6}[0-9A-Z<]([MF])/
          );

        if (sexMatch) {
          sex = sexMatch[1];

          const pos =
            line2.indexOf(
              sexMatch[0]
            );

          if (pos >= 0) {
            expiryRaw =
              line2.slice(
                pos + 7,
                pos + 13
              );
          }
        }
      }

      /*
       * DOB fallback.
       */
      let dob =
        parseMRZDate(
          dobRaw,
          "dob"
        );

      /*
       * Expiry fallback.
       */
      let expiry =
        parseMRZDate(
          expiryRaw,
          "expiry"
        );

      /*
       * Kalau expiry gagal,
       * cari pola:
       *
       * DOB + check + SEX + EXPIRY
       *
       * contoh:
       * 8307118M330209
       */
      if (!expiry) {
        const expiryMatch =
          line2.match(
            /\d{6}[0-9A-Z<][MF](\d{6})/
          );

        if (expiryMatch) {
          expiry =
            parseMRZDate(
              expiryMatch[1],
              "expiry"
            );
        }
      }

      /*
       * Passport number:
       * buang filler <.
       */
      passportNumber =
        passportNumber
          .replace(/</g, "");

      /*
       * MRZ nama
       */
      let surname = null;
      let givenNames = null;

      if (first) {
        const line1 = first
          .padEnd(44, "<")
          .slice(0, 44);

        const namePart =
          line1.slice(5, 44);

        const nameParts =
          namePart
            .split("<<")
            .map((x) =>
              x
                .replace(/</g, " ")
                .replace(/\s+/g, " ")
                .trim()
            )
            .filter(Boolean);

        surname =
          nameParts[0] || null;

        givenNames =
          nameParts
            .slice(1)
            .join(" ")
            .trim() || null;
      }

      return {
        raw: first
          ? `${first}\n${second}`
          : second,

        passport_number:
          passportNumber || null,

        nationality:
          nationality || null,

        date_of_birth:
          dob,

        sex:
          sex === "M" ||
          sex === "F"
            ? sex
            : null,

        date_of_expiry:
          expiry,

        surname,
        given_names: givenNames,
      };
    }

    /*
    ============================================================
    13. PASSPORT LABEL PARSER
    ============================================================
    */

    function getPassportLabelValue(
      lines,
      labels,
      validator
    ) {
      const normalizedLabels =
        labels.map(normalizeOCRText);

      for (let i = 0; i < lines.length; i++) {
        const original = lines[i];
        const current =
          normalizeOCRText(original);

        for (const label of normalizedLabels) {
          /*
           * CASE:
           *
           * NATIONALITY INDONESIAN
           */
          if (
            current.startsWith(
              label + " "
            )
          ) {
            let remainder =
              original
                .slice(
                  original
                    .toUpperCase()
                    .indexOf(label) +
                    label.length
                )
                .trim();

            remainder =
              remainder
                .replace(
                  /^[:\-\/]+/,
                  ""
                )
                .trim();

            if (
              remainder &&
              !isLabelOnly(remainder) &&
              (!validator ||
                validator(remainder))
            ) {
              return cleanText(
                remainder
              );
            }
          }

          /*
           * CASE:
           *
           * LABEL
           * VALUE
           */
          if (
            current === label ||
            current.replace(
              /[:\-]/g,
              ""
            ).trim() === label
          ) {
            for (
              let j = i + 1;
              j <=
              Math.min(
                i + 3,
                lines.length - 1
              );
              j++
            ) {
              const candidate =
                cleanText(lines[j]);

              if (!candidate) continue;

              if (
                isLabelOnly(candidate)
              ) {
                continue;
              }

              if (
                validator &&
                !validator(candidate)
              ) {
                continue;
              }

              return candidate;
            }
          }
        }
      }

      return null;
    }

    /*
    ============================================================
    14. SPATIAL / OVERLAY PASSPORT PARSER
    ============================================================
    */

    function buildSpatialLines(words) {
      if (!Array.isArray(words) || !words.length) {
        return [];
      }

      const sorted = [...words].sort(
        (a, b) => {
          if (
            Math.abs(
              a.centerY - b.centerY
            ) < 12
          ) {
            return a.left - b.left;
          }

          return a.centerY - b.centerY;
        }
      );

      const rows = [];

      for (const word of sorted) {
        let row = rows.find(
          (r) =>
            Math.abs(
              r.centerY -
                word.centerY
            ) <= 12
        );

        if (!row) {
          row = {
            words: [],
            centerY: word.centerY,
          };

          rows.push(row);
        }

        row.words.push(word);

        row.centerY =
          row.words.reduce(
            (sum, x) =>
              sum + x.centerY,
            0
          ) / row.words.length;
      }

      return rows
        .sort(
          (a, b) =>
            a.centerY - b.centerY
        )
        .map((row) => {
          const sortedWords =
            row.words.sort(
              (a, b) =>
                a.left - b.left
            );

          return {
            text: sortedWords
              .map((x) => x.text)
              .join(" ")
              .trim(),

            words: sortedWords,

            centerY:
              sortedWords.reduce(
                (sum, x) =>
                  sum + x.centerY,
                0
              ) /
              sortedWords.length,
          };
        });
    }

    const spatialLines =
      buildSpatialLines(
        overlayWords
      );

    function spatialValueAfterLabel(
      labelVariants,
      validator
    ) {
      if (!spatialLines.length) {
        return null;
      }

      const labels =
        labelVariants.map(
          normalizeOCRText
        );

      for (
        let i = 0;
        i < spatialLines.length;
        i++
      ) {
        const row =
          spatialLines[i];

        const rowText =
          normalizeOCRText(
            row.text
          );

        const hasLabel =
          labels.some(
            (label) =>
              rowText === label ||
              rowText.includes(
                label
              )
          );

        if (!hasLabel) {
          continue;
        }

        /*
         * Cari value di kanan label
         */
        const labelWords =
          row.words.filter(
            (word) =>
              labels.some(
                (label) =>
                  normalizeOCRText(
                    word.text
                  ).includes(label)
              )
          );

        const labelRight =
          labelWords.length
            ? Math.max(
                ...labelWords.map(
                  (x) => x.right
                )
              )
            : 0;

        const rightWords =
          row.words
            .filter(
              (word) =>
                word.left >
                labelRight + 2
            )
            .map(
              (x) => x.text
            )
            .join(" ")
            .trim();

        if (
          rightWords &&
          !isLabelOnly(
            rightWords
          ) &&
          (!validator ||
            validator(
              rightWords
            ))
        ) {
          return cleanText(
            rightWords
          );
        }

        /*
         * Kalau tidak ada di kanan,
         * cari baris di bawah.
         */
        for (
          let j = i + 1;
          j <=
          Math.min(
            i + 2,
            spatialLines.length - 1
          );
          j++
        ) {
          const candidate =
            cleanText(
              spatialLines[j].text
            );

          if (!candidate) continue;

          if (
            isLabelOnly(candidate)
          ) {
            continue;
          }

          if (
            validator &&
            !validator(candidate)
          ) {
            continue;
          }

          return candidate;
        }
      }

      return null;
    }

    /*
    ============================================================
    15. PASSPORT PARSER
    ============================================================
    */

    function parsePassport(text) {
      const lines =
        linesFromText(text);

      const mrz =
        parseMRZ(text);

      const result = {
        nomor_passport: null,
        nama: null,
        nationality: null,
        tanggal_lahir: null,
        tempat_lahir: null,
        jenis_kelamin: null,
        tanggal_terbit: null,
        tanggal_expired: null,
        issuing_office: null,
        mrz: mrz.raw,
      };

      /*
       * ========================================================
       * PASSPORT NUMBER
       * ========================================================
       */

      if (
        mrz.passport_number &&
        isPassportNumber(
          mrz.passport_number
        )
      ) {
        result.nomor_passport =
          normalizePassportNumber(
            mrz.passport_number
          );
      }

      if (
        !result.nomor_passport
      ) {
        for (const line of lines) {
          const matches =
            line.match(
              /\b[A-Z][A-Z0-9]{6,8}\b/g
            ) || [];

          for (
            const candidate of matches
          ) {
            const p =
              normalizePassportNumber(
                candidate
              );

            if (p) {
              result.nomor_passport =
                p;
              break;
            }
          }

          if (
            result.nomor_passport
          ) {
            break;
          }
        }
      }

      /*
       * ========================================================
       * NAMA
       * ========================================================
       */

      const surname =
        getPassportLabelValue(
          lines,
          ["SURNAME"],
          isPassportName
        );

      const givenNames =
        getPassportLabelValue(
          lines,
          [
            "GIVEN NAMES",
            "GIVEN NAME",
          ],
          isPassportName
        );

      if (
        surname &&
        givenNames
      ) {
        result.nama =
          `${surname} ${givenNames}`
            .replace(/\s+/g, " ")
            .trim();
      } else if (surname) {
        result.nama = surname;
      } else if (givenNames) {
        result.nama =
          givenNames;
      }

      /*
       * Fallback MRZ.
       */
      if (!result.nama) {
        const mrzName = [
          mrz.surname,
          mrz.given_names,
        ]
          .filter(Boolean)
          .join(" ")
          .trim();

        if (
          isPassportName(
            mrzName
          )
        ) {
          result.nama =
            mrzName;
        }
      }

      if (!result.nama) {
        result.nama =
          getPassportLabelValue(
            lines,
            ["NAME", "NAMA"],
            isPassportName
          );
      }

      /*
       * ========================================================
       * NATIONALITY
       * ========================================================
       */

      if (
        mrz.nationality &&
        isNationality(
          mrz.nationality
        )
      ) {
        result.nationality =
          normalizeNationality(
            mrz.nationality
          );
      }

      if (
        !result.nationality
      ) {
        const nationality =
          getPassportLabelValue(
            lines,
            ["NATIONALITY"],
            isNationality
          );

        if (nationality) {
          result.nationality =
            normalizeNationality(
              nationality
            );
        }
      }

      /*
       * ========================================================
       * DATE OF BIRTH
       * ========================================================
       */

      /*
       * MRZ PRIORITAS.
       */
      if (mrz.date_of_birth) {
        result.tanggal_lahir =
          mrz.date_of_birth;
      }

      if (
        !result.tanggal_lahir
      ) {
        result.tanggal_lahir =
          getPassportLabelValue(
            lines,
            [
              "DATE OF BIRTH",
              "TANGGAL LAHIR",
            ],
            (value) =>
              !!normalizeDate(value)
          );
      }

      /*
       * ========================================================
       * SEX
       * ========================================================
       */

      if (
        mrz.sex === "M" ||
        mrz.sex === "F"
      ) {
        result.jenis_kelamin =
          mrz.sex;
      }

      if (
        !result.jenis_kelamin
      ) {
        const sex =
          getPassportLabelValue(
            lines,
            [
              "SEX",
              "GENDER",
              "JENIS KELAMIN",
            ],
            (value) =>
              !!normalizeSex(value)
          );

        result.jenis_kelamin =
          normalizeSex(sex);
      }

      /*
       * ========================================================
       * EXPIRY
       * ========================================================
       *
       * SEKARANG MRZ MENJADI SUMBER UTAMA.
       */

      if (
        mrz.date_of_expiry
      ) {
        result.tanggal_expired =
          mrz.date_of_expiry;
      }

      if (
        !result.tanggal_expired
      ) {
        result.tanggal_expired =
          getPassportLabelValue(
            lines,
            [
              "DATE OF EXPIRY",
              "DATE OF EXPIRATION",
              "EXPIRY DATE",
              "TANGGAL EXPIRED",
            ],
            (value) =>
              !!normalizeDate(value)
          );
      }

      /*
       * ========================================================
       * PLACE OF BIRTH
       * ========================================================
       *
       * JANGAN PERNAH MENGAMBIL:
       *
       * / PLACE OF BIRTH
       *
       * sebagai value.
       */

      result.tempat_lahir =
        getPassportLabelValue(
          lines,
          [
            "PLACE OF BIRTH",
            "TEMPAT LAHIR",
          ],
          isPassportPlace
        );

      /*
       * Spatial fallback.
       */
      if (
        !result.tempat_lahir
      ) {
        result.tempat_lahir =
          spatialValueAfterLabel(
            [
              "PLACE OF BIRTH",
              "TEMPAT LAHIR",
            ],
            isPassportPlace
          );
      }

      /*
       * Final rejection.
       */
      if (
        result.tempat_lahir &&
        !isPassportPlace(
          result.tempat_lahir
        )
      ) {
        result.tempat_lahir =
          null;
      }

      /*
       * ========================================================
       * DATE OF ISSUE
       * ========================================================
       */

      result.tanggal_terbit =
        getPassportLabelValue(
          lines,
          [
            "DATE OF ISSUE",
            "DATE OF ISSUANCE",
            "TANGGAL TERBIT",
          ],
          (value) =>
            !!normalizeDate(value)
        );

      /*
       * Spatial fallback.
       */
      if (
        !result.tanggal_terbit
      ) {
        result.tanggal_terbit =
          spatialValueAfterLabel(
            [
              "DATE OF ISSUE",
              "DATE OF ISSUANCE",
              "TANGGAL TERBIT",
            ],
            (value) =>
              !!normalizeDate(value)
          );
      }

      /*
       * ========================================================
       * ISSUING OFFICE
       * ========================================================
       */

      result.issuing_office =
        getPassportLabelValue(
          lines,
          [
            "ISSUING AUTHORITY",
            "ISSUING OFFICE",
            "AUTHORITY",
          ],
          (value) => {
            const v =
              normalizeOCRText(
                value
              );

            if (!v) return false;

            if (
              isDate(v) ||
              v.includes(
                "PLACE OF"
              ) ||
              v.includes(
                "DATE OF"
              ) ||
              v.includes(
                "NATIONALITY"
              ) ||
              v.includes(
                "PASSPORT"
              )
            ) {
              return false;
            }

            return v.length >= 2;
          }
        );

      if (
        !result.issuing_office
      ) {
        result.issuing_office =
          spatialValueAfterLabel(
            [
              "ISSUING AUTHORITY",
              "ISSUING OFFICE",
              "AUTHORITY",
            ],
            (value) => {
              const v =
                normalizeOCRText(
                  value
                );

              return (
                v.length >= 2 &&
                !isDate(v) &&
                !v.includes(
                  "PLACE OF"
                ) &&
                !v.includes(
                  "DATE OF"
                )
              );
            }
          );
      }

      /*
       * ========================================================
       * FINAL CLEANUP
       * ========================================================
       */

      if (
        result.tanggal_lahir &&
        !isDate(
          result.tanggal_lahir
        )
      ) {
        result.tanggal_lahir =
          null;
      }

      if (
        result.tanggal_terbit &&
        !isDate(
          result.tanggal_terbit
        )
      ) {
        result.tanggal_terbit =
          null;
      }

      if (
        result.tanggal_expired &&
        !isDate(
          result.tanggal_expired
        )
      ) {
        result.tanggal_expired =
          null;
      }

      if (
        result.nationality &&
        !isNationality(
          result.nationality
        )
      ) {
        result.nationality =
          null;
      }

      if (
        result.jenis_kelamin !== "M" &&
        result.jenis_kelamin !== "F"
      ) {
        result.jenis_kelamin =
          null;
      }

      return result;
    }

    /*
    ============================================================
    16. KK
    ============================================================
    */

    function parseKK(text) {
      const lines =
        linesFromText(text);

      const result = {
        no_kk: null,
        nik: null,
        nama: null,
        nama_ayah: null,
      };

      const all16 =
        text.match(
          /\b\d{16}\b/g
        ) || [];

      if (all16.length) {
        result.no_kk =
          all16[0];
      }

      if (all16.length >= 2) {
        result.nik =
          all16[1];
      }

      result.nama =
        valueAfterLabel(
          lines,
          ["NAMA"]
        );

      /*
       * TIDAK BOLEH INFER DARI KEPALA KELUARGA.
       */
      result.nama_ayah =
        valueAfterLabel(
          lines,
          ["NAMA AYAH"]
        );

      return result;
    }

    /*
    ============================================================
    17. DOCUMENT TYPE
    ============================================================
    */

    function detectDocumentType(
      type,
      text
    ) {
      const t =
        String(type || "")
          .toLowerCase()
          .trim();

      if (
        ["ktp", "kk", "passport"].includes(
          t
        )
      ) {
        return t;
      }

      const u =
        upper(text);

      if (
        u.includes(
          "KARTU KELUARGA"
        ) ||
        u.includes(
          "NAMA AYAH"
        )
      ) {
        return "kk";
      }

      if (
        u.includes(
          "NATIONALITY"
        ) ||
        u.includes(
          "PLACE OF BIRTH"
        ) ||
        u.includes(
          "PASSPORT"
        )
      ) {
        return "passport";
      }

      return "ktp";
    }

    const detectedType =
      detectDocumentType(
        documentType,
        rawText
      );

    /*
    ============================================================
    18. PARSE
    ============================================================
    */

    let data;

    if (
      detectedType ===
      "passport"
    ) {
      data =
        parsePassport(
          rawText
        );
    } else if (
      detectedType === "kk"
    ) {
      data =
        parseKK(
          rawText
        );
    } else {
      data =
        parseKTP(
          rawText
        );
    }

    /*
    ============================================================
    19. VALIDATION
    ============================================================
    */

    function validateKTP(data) {
      const missing = [];

      const required = {
        nik: "NIK",
        nama: "Nama",
        tempat_lahir: "Tempat Lahir",
        tanggal_lahir: "Tanggal Lahir",
        jenis_kelamin: "Jenis Kelamin",
        alamat: "Alamat",
        rt_rw: "RT/RW",
        kelurahan_desa: "Kelurahan/Desa",
        kecamatan: "Kecamatan",
        status_perkawinan: "Status Perkawinan",
        pekerjaan: "Pekerjaan",
        kewarganegaraan: "Kewarganegaraan",
      };

      for (
        const [key, label]
        of Object.entries(required)
      ) {
        if (!data[key]) {
          missing.push(label);
        }
      }

      const invalid = [];

      if (
        data.nik &&
        !/^\d{16}$/.test(
          data.nik
        )
      ) {
        invalid.push("NIK");
      }

      return {
        ok:
          missing.length === 0 &&
          invalid.length === 0,
        missing,
        invalid,
      };
    }

    function validatePassport(
      data
    ) {
      const missing = [];

      const required = {
        nomor_passport:
          "Nomor Passport",

        nama:
          "Nama",

        nationality:
          "Nationality",

        tanggal_lahir:
          "Tanggal Lahir",

        tempat_lahir:
          "Tempat Lahir",

        jenis_kelamin:
          "Jenis Kelamin",

        tanggal_terbit:
          "Tanggal Terbit",

        tanggal_expired:
          "Tanggal Expired",

        issuing_office:
          "Issuing Office",

        mrz:
          "MRZ",
      };

      for (
        const [key, label]
        of Object.entries(required)
      ) {
        if (!data[key]) {
          missing.push(label);
        }
      }

      const invalid = [];

      if (
        data.nomor_passport &&
        !isPassportNumber(
          data.nomor_passport
        )
      ) {
        invalid.push(
          "Nomor Passport"
        );
      }

      if (
        data.tanggal_lahir &&
        !isDate(
          data.tanggal_lahir
        )
      ) {
        invalid.push(
          "Tanggal Lahir"
        );
      }

      if (
        data.tanggal_terbit &&
        !isDate(
          data.tanggal_terbit
        )
      ) {
        invalid.push(
          "Tanggal Terbit"
        );
      }

      if (
        data.tanggal_expired &&
        !isDate(
          data.tanggal_expired
        )
      ) {
        invalid.push(
          "Tanggal Expired"
        );
      }

      return {
        ok:
          missing.length === 0 &&
          invalid.length === 0,

        missing,
        invalid,
      };
    }

    function validateKK(
      data
    ) {
      const missing = [];

      const required = {
        no_kk: "No. KK",
        nik: "NIK",
        nama: "Nama",
        nama_ayah: "Nama Ayah",
      };

      for (
        const [key, label]
        of Object.entries(required)
      ) {
        if (!data[key]) {
          missing.push(label);
        }
      }

      return {
        ok:
          missing.length === 0,

        missing,
        invalid: [],
      };
    }

    let validation;

    if (
      detectedType ===
      "passport"
    ) {
      validation =
        validatePassport(
          data
        );
    } else if (
      detectedType === "kk"
    ) {
      validation =
        validateKK(
          data
        );
    } else {
      validation =
        validateKTP(
          data
        );
    }

    /*
    ============================================================
    20. RESPONSE
    ============================================================
    */

    return res.status(200).json({
      ok: true,

      documentType:
        detectedType,

      fileName:
        fileName || null,

      data,

      validation,

      rawText,

      overlay:
        overlayWords,

      ocr: {
        parsedResultsCount:
          parsedResults.length,

        processingTimeInMilliseconds:
          ocr.ProcessingTimeInMilliseconds ||
          null,

        engine:
          ocr.OCRExitCode ||
          null,
      },
    });
  } catch (error) {
    console.error(
      "OCR ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Terjadi kesalahan pada server OCR.",
    });
  }
}
