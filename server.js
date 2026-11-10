import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import multer from "multer"
import crypto from "node:crypto"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"

dotenv.config()

const app = express()

const PORT = Number(process.env.PORT || 8010)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://rpl-s3-uploader-frontend.vercel.app"
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100)

const MINIO_ENDPOINT = (process.env.MINIO_ENDPOINT || "http://3.137.219.87:9000").replace(/\/+$/, "")
const MINIO_BUCKET = process.env.MINIO_BUCKET || "rotas"
const MINIO_REGION = process.env.MINIO_REGION || "us-east-1"
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || ""
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || ""

// Chave fixa: cada upload sobrescreve o arquivo anterior
const MINIO_KEY = (process.env.MINIO_KEY || "rpl/rpl.csv").replace(/^\/+/, "")
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 60) * 1000

const MINIO_OBJECT_URL = `${MINIO_ENDPOINT}/${[MINIO_BUCKET, ...MINIO_KEY.split("/")]
  .map(encodeURIComponent)
  .join("/")}`

// Com chaves usa requisições assinadas; sem chaves usa acesso anônimo (bucket público)
const s3 =
  MINIO_ACCESS_KEY && MINIO_SECRET_KEY
    ? new S3Client({
        endpoint: MINIO_ENDPOINT,
        region: MINIO_REGION,
        forcePathStyle: true,
        credentials: {
          accessKeyId: MINIO_ACCESS_KEY,
          secretAccessKey: MINIO_SECRET_KEY
        }
      })
    : null

async function minioPut(buffer, filename) {
  const encodedName = encodeURIComponent(filename || "rpl.csv")

  try {
    if (s3) {
      await s3.send(
        new PutObjectCommand({
          Bucket: MINIO_BUCKET,
          Key: MINIO_KEY,
          Body: buffer,
          ContentType: "text/csv",
          ContentLength: buffer.length,
          Metadata: {
            filename: encodedName
          }
        })
      )
      return
    }

    const response = await fetch(MINIO_OBJECT_URL, {
      method: "PUT",
      headers: {
        "Content-Type": "text/csv",
        "x-amz-meta-filename": encodedName
      },
      body: buffer
    })

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)

      throw new Error(`HTTP ${response.status} ${detail}`)
    }
  } catch (error) {
    throw new Error(`Falha ao enviar para o MinIO: ${error.message || error.name}`)
  }
}

function decodeFilename(value) {
  try {
    return decodeURIComponent(value || "")
  } catch {
    return String(value || "")
  }
}

// Retorna null quando ainda não existe arquivo no bucket
async function minioGet() {
  try {
    if (s3) {
      try {
        const object = await s3.send(
          new GetObjectCommand({
            Bucket: MINIO_BUCKET,
            Key: MINIO_KEY
          })
        )

        return {
          buffer: Buffer.from(await object.Body.transformToByteArray()),
          filename: decodeFilename(object.Metadata?.filename),
          lastModified: object.LastModified || null
        }
      } catch (error) {
        if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) {
          return null
        }

        throw error
      }
    }

    const response = await fetch(MINIO_OBJECT_URL)

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)

      throw new Error(`HTTP ${response.status} ${detail}`)
    }

    const lastModified = response.headers.get("last-modified")

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      filename: decodeFilename(response.headers.get("x-amz-meta-filename")),
      lastModified: lastModified ? new Date(lastModified) : null
    }
  } catch (error) {
    throw new Error(`Falha ao ler do MinIO: ${error.message || error.name}`)
  }
}

const allowedOrigins = [
  FRONTEND_ORIGIN,
  "https://rpl-s3-uploader-frontend.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175"
].filter(Boolean)

function isAllowedOrigin(origin) {
  if (!origin) {
    return true
  }

  if (allowedOrigins.includes(origin)) {
    return true
  }

  if (/^https:\/\/.+\.vercel\.app$/.test(origin)) {
    return true
  }

  if (/^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin)) {
    return true
  }

  if (/^http:\/\/10\.\d+\.\d+\.\d+:\d+$/.test(origin)) {
    return true
  }

  if (/^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/.test(origin)) {
    return true
  }

  return false
}

const corsOptions = {
  origin(origin, callback) {
    // Origem não liberada fica sem os headers de CORS (o navegador bloqueia);
    // chamadas de mesma origem, via proxy em /rpl, continuam funcionando
    return callback(null, isAllowedOrigin(origin))
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin"],
  exposedHeaders: ["Content-Length", "Content-Type"],
  credentials: false,
  optionsSuccessStatus: 204
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024
  },
  fileFilter(_req, file, callback) {
    const originalName = String(file.originalname || "").toLowerCase()

    if (!originalName.endsWith(".csv")) {
      return callback(new Error("Envie apenas arquivo CSV"))
    }

    return callback(null, true)
  }
})

app.use(cors(corsOptions))
app.options(/.*/, cors(corsOptions))
app.use(express.json({ limit: "10mb" }))

function splitCsvLine(line, delimiter = ";") {
  const result = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === delimiter && !inQuotes) {
      result.push(current.trim())
      current = ""
      continue
    }

    current += char
  }

  result.push(current.trim())

  return result
}

function normalizeText(value) {
  return String(value ?? "").trim()
}

function normalizeUpper(value) {
  return normalizeText(value).toUpperCase()
}

function parseDateToIso(value) {
  const text = normalizeText(value)
  const digits = text.replace(/\D/g, "")

  if (!digits) {
    return null
  }

  if (/^\d{6}$/.test(digits)) {
    const day = digits.slice(0, 2)
    const month = digits.slice(2, 4)
    const year = Number(digits.slice(4, 6))
    const fullYear = year >= 70 ? 1900 + year : 2000 + year

    return `${fullYear}-${month}-${day}`
  }

  if (/^\d{8}$/.test(digits)) {
    const first = Number(digits.slice(0, 4))

    if (first > 1900) {
      const year = digits.slice(0, 4)
      const month = digits.slice(4, 6)
      const day = digits.slice(6, 8)

      return `${year}-${month}-${day}`
    }

    const day = digits.slice(0, 2)
    const month = digits.slice(2, 4)
    const year = digits.slice(4, 8)

    return `${year}-${month}-${day}`
  }

  return null
}

function parseBooleanDay(value) {
  const text = normalizeUpper(value)

  if (!text) {
    return false
  }

  if (text === "0") {
    return false
  }

  return (
    text === "1" ||
    text === "2" ||
    text === "3" ||
    text === "4" ||
    text === "5" ||
    text === "6" ||
    text === "7" ||
    text === "S" ||
    text === "SIM" ||
    text === "Y" ||
    text === "YES" ||
    text === "TRUE" ||
    text === "X"
  )
}

function normalizeTime(value) {
  const text = normalizeText(value)

  if (!text) {
    return ""
  }

  const digits = text.replace(/\D/g, "")

  if (/^\d{4}$/.test(digits)) {
    return digits
  }

  if (/^\d{3}$/.test(digits)) {
    return `0${digits}`
  }

  if (/^\d{1,2}$/.test(digits)) {
    return digits.padStart(4, "0")
  }

  return text
}

function parseRow(cols, originalLine) {
  return {
    id: crypto.randomUUID(),

    flight_number: normalizeUpper(cols[10]),
    equipment: normalizeUpper(cols[11]),

    start_date: parseDateToIso(cols[1]),
    end_date: parseDateToIso(cols[2]),

    is_monday: parseBooleanDay(cols[3]),
    is_tuesday: parseBooleanDay(cols[4]),
    is_wednesday: parseBooleanDay(cols[5]),
    is_thursday: parseBooleanDay(cols[6]),
    is_friday: parseBooleanDay(cols[7]),
    is_saturday: parseBooleanDay(cols[8]),
    is_sunday: parseBooleanDay(cols[9]),

    departure: normalizeUpper(cols[13]),
    arrival: normalizeUpper(cols[18]),

    eobt: normalizeTime(cols[14]),
    speed: normalizeUpper(cols[15]),
    flight_level: normalizeUpper(cols[16]),
    route: normalizeUpper(cols[17]),
    eet: normalizeTime(cols[19]),
    remarks: normalizeText(cols[20]),

    original_line: originalLine
  }
}

function isValidFlight(row) {
  if (!row.flight_number) {
    return false
  }

  if (!row.departure) {
    return false
  }

  if (!row.arrival) {
    return false
  }

  if (!/^[A-Z]{4}$/.test(row.departure)) {
    return false
  }

  if (!/^[A-Z]{4}$/.test(row.arrival)) {
    return false
  }

  return true
}

function parseCsv(buffer) {
  const raw = buffer.toString("latin1")

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const rows = []
  const ignored = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const cols = splitCsvLine(line, ";")

    if (cols.length < 21) {
      ignored.push({
        line: index + 1,
        reason: "Linha com menos de 21 colunas"
      })
      continue
    }

    const row = parseRow(cols, line)

    if (!isValidFlight(row)) {
      ignored.push({
        line: index + 1,
        reason: "Linha inválida",
        flight_number: row.flight_number,
        departure: row.departure,
        arrival: row.arrival
      })
      continue
    }

    rows.push(row)
  }

  return {
    totalLines: lines.length,
    rows,
    ignored
  }
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""))
}

function buildRplData(parsed, filename, importedAt) {
  const flights = parsed.rows
    .map(({ original_line: _originalLine, ...row }) => ({
      ...row,
      // Sem fuso: o frontend faz new Date(valor) e precisa cair no dia certo no horário local
      start_date: row.start_date ? `${row.start_date}T00:00:00` : null,
      end_date: row.end_date ? `${row.end_date}T00:00:00` : null
    }))
    .sort(
      (a, b) =>
        compareText(a.flight_number, b.flight_number) ||
        compareText(a.departure, b.departure) ||
        compareText(a.arrival, b.arrival) ||
        compareText(a.eobt, b.eobt)
    )

  return {
    flights,
    lastImport: {
      filename: filename || MINIO_KEY.split("/").pop(),
      totalLines: parsed.totalLines,
      totalFlights: flights.length,
      totalIgnored: parsed.ignored.length,
      importedAt: importedAt || new Date()
    }
  }
}

let rplCache = null

async function getRplData() {
  if (rplCache && Date.now() - rplCache.loadedAt < CACHE_TTL_MS) {
    return rplCache.data
  }

  const object = await minioGet()

  const data = object
    ? buildRplData(parseCsv(object.buffer), object.filename, object.lastModified)
    : {
        flights: [],
        lastImport: null
      }

  rplCache = {
    loadedAt: Date.now(),
    data
  }

  return data
}

// Usado pelo deploy para conferir se o servidor está no ar
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true
  })
})

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "rpl-minio-uploader-backend",
    storage: "minio",
    bucket: MINIO_BUCKET,
    key: MINIO_KEY,
    frontendOrigin: FRONTEND_ORIGIN,
    allowedOrigins
  })
})

app.get("/api/status", async (_req, res) => {
  try {
    const data = await getRplData()

    res.json({
      ok: true,
      storage: true,
      totalFlights: data.flights.length,
      lastImport: data.lastImport
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    })
  }
})

app.get("/api/flights", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 1000, 50000))
    const data = await getRplData()
    const flights = data.flights.slice(0, limit)

    res.json({
      ok: true,
      total: flights.length,
      data: flights
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    })
  }
})

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Nenhum arquivo enviado"
      })
    }

    // O multer entrega o nome em latin1; converte para manter acentos
    const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8")
    const parsed = parseCsv(req.file.buffer)

    if (parsed.rows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Nenhum voo válido encontrado no CSV",
        totalLines: parsed.totalLines,
        totalIgnored: parsed.ignored.length,
        ignored: parsed.ignored.slice(0, 20)
      })
    }

    await minioPut(req.file.buffer, filename)

    const data = buildRplData(parsed, filename, new Date())

    rplCache = {
      loadedAt: Date.now(),
      data
    }

    res.json({
      ok: true,
      message: "CSV salvo no MinIO com sucesso",
      filename,
      size: req.file.size,
      storage: {
        bucket: MINIO_BUCKET,
        key: MINIO_KEY
      },
      totalLines: data.lastImport.totalLines,
      totalFlights: data.lastImport.totalFlights,
      totalIgnored: data.lastImport.totalIgnored,
      ignoredSample: parsed.ignored.slice(0, 20)
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    })
  }
})

app.use((error, _req, res, _next) => {
  res.status(400).json({
    ok: false,
    error: error.message || "Erro no upload"
  })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend rodando em http://localhost:${PORT}`)
  console.log(`MinIO: ${MINIO_OBJECT_URL} (${s3 ? "com credenciais" : "acesso anônimo"})`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0))
}
