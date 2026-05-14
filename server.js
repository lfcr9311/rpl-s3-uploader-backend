import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import multer from "multer"
import pg from "pg"
import crypto from "node:crypto"

dotenv.config()

const { Pool } = pg

const app = express()

const PORT = Number(process.env.PORT || 8010)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5174"
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5433/postgres"
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100)

const pool = new Pool({
  connectionString: DATABASE_URL
})

const allowedOrigins = [
  FRONTEND_ORIGIN,
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
    if (isAllowedOrigin(origin)) {
      return callback(null, true)
    }

    return callback(new Error(`CORS bloqueado para origem: ${origin}`))
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

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rpl_import_control (
      id UUID PRIMARY KEY,
      filename TEXT,
      total_lines INTEGER NOT NULL DEFAULT 0,
      total_flights INTEGER NOT NULL DEFAULT 0,
      total_ignored INTEGER NOT NULL DEFAULT 0,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rpl_flight (
      id UUID PRIMARY KEY,

      flight_number TEXT NOT NULL,
      equipment TEXT,

      start_date DATE,
      end_date DATE,

      is_monday BOOLEAN NOT NULL DEFAULT FALSE,
      is_tuesday BOOLEAN NOT NULL DEFAULT FALSE,
      is_wednesday BOOLEAN NOT NULL DEFAULT FALSE,
      is_thursday BOOLEAN NOT NULL DEFAULT FALSE,
      is_friday BOOLEAN NOT NULL DEFAULT FALSE,
      is_saturday BOOLEAN NOT NULL DEFAULT FALSE,
      is_sunday BOOLEAN NOT NULL DEFAULT FALSE,

      departure TEXT NOT NULL,
      arrival TEXT NOT NULL,

      eobt TEXT,
      speed TEXT,
      flight_level TEXT,
      route TEXT,
      eet TEXT,
      remarks TEXT,

      original_line TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rpl_flight_flight_number
    ON rpl_flight(flight_number)
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rpl_flight_departure_arrival
    ON rpl_flight(departure, arrival)
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rpl_flight_eobt
    ON rpl_flight(eobt)
  `)
}

async function replaceRplData(input) {
  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    await client.query(`
  TRUNCATE TABLE
    rpl_import_control,
    rpl_flight
  RESTART IDENTITY CASCADE
`)

    await client.query(
      `
        INSERT INTO rpl_import_control (
          id,
          filename,
          total_lines,
          total_flights,
          total_ignored
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        crypto.randomUUID(),
        input.filename,
        input.totalLines,
        input.rows.length,
        input.ignored.length
      ]
    )

    const sql = `
      INSERT INTO rpl_flight (
        id,
        flight_number,
        equipment,
        start_date,
        end_date,
        is_monday,
        is_tuesday,
        is_wednesday,
        is_thursday,
        is_friday,
        is_saturday,
        is_sunday,
        departure,
        arrival,
        eobt,
        speed,
        flight_level,
        route,
        eet,
        remarks,
        original_line
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18,
        $19, $20, $21
      )
    `

    for (const row of input.rows) {
      await client.query(sql, [
        row.id,
        row.flight_number,
        row.equipment || null,
        row.start_date,
        row.end_date,
        row.is_monday,
        row.is_tuesday,
        row.is_wednesday,
        row.is_thursday,
        row.is_friday,
        row.is_saturday,
        row.is_sunday,
        row.departure,
        row.arrival,
        row.eobt || null,
        row.speed || null,
        row.flight_level || null,
        row.route || null,
        row.eet || null,
        row.remarks || null,
        row.original_line || null
      ])
    }

    await client.query("COMMIT")

    return {
      totalLines: input.totalLines,
      totalFlights: input.rows.length,
      totalIgnored: input.ignored.length
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "rpl-postgres-uploader-backend",
    database: "postgres",
    frontendOrigin: FRONTEND_ORIGIN
  })
})

app.get("/api/status", async (_req, res) => {
  try {
    const importInfo = await pool.query(`
      SELECT
        filename,
        total_lines AS "totalLines",
        total_flights AS "totalFlights",
        total_ignored AS "totalIgnored",
        imported_at AS "importedAt"
      FROM rpl_import_control
      ORDER BY imported_at DESC
      LIMIT 1
    `)

    const count = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM rpl_flight
    `)

    res.json({
      ok: true,
      database: true,
      totalFlights: count.rows[0]?.total || 0,
      lastImport: importInfo.rows[0] || null
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
    const limit = Math.min(Number(req.query.limit || 1000), 50000)

    const result = await pool.query(
      `
        SELECT
          id,
          flight_number,
          equipment,
          start_date,
          end_date,
          is_monday,
          is_tuesday,
          is_wednesday,
          is_thursday,
          is_friday,
          is_saturday,
          is_sunday,
          departure,
          arrival,
          eobt,
          speed,
          flight_level,
          route,
          eet,
          remarks,
          created_at
        FROM rpl_flight
        ORDER BY flight_number, departure, arrival, eobt
        LIMIT $1
      `,
      [limit]
    )

    res.json({
      ok: true,
      total: result.rows.length,
      data: result.rows
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

    const result = await replaceRplData({
      filename: req.file.originalname,
      totalLines: parsed.totalLines,
      rows: parsed.rows,
      ignored: parsed.ignored
    })

    res.json({
      ok: true,
      message: "CSV importado para o Postgres com sucesso",
      filename: req.file.originalname,
      size: req.file.size,
      ...result,
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

async function start() {
  try {
    await ensureTables()

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Backend rodando em http://localhost:${PORT}`)
      console.log(`Banco: ${DATABASE_URL}`)
      console.log(`Frontend liberado: ${FRONTEND_ORIGIN}`)
    })
  } catch (error) {
    console.error("Erro ao iniciar backend")
    console.error(error)
    process.exit(1)
  }
}

process.on("SIGINT", async () => {
  await pool.end()
  process.exit(0)
})

process.on("SIGTERM", async () => {
  await pool.end()
  process.exit(0)
})

start()