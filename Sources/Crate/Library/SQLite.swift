import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

protocol SQLBindable {
    func bind(to statement: OpaquePointer, at index: Int32)
}

extension String: SQLBindable {
    func bind(to statement: OpaquePointer, at index: Int32) {
        sqlite3_bind_text(statement, index, self, -1, SQLITE_TRANSIENT)
    }
}

extension Int: SQLBindable {
    func bind(to statement: OpaquePointer, at index: Int32) {
        sqlite3_bind_int64(statement, index, Int64(self))
    }
}

extension Int64: SQLBindable {
    func bind(to statement: OpaquePointer, at index: Int32) {
        sqlite3_bind_int64(statement, index, self)
    }
}

extension Double: SQLBindable {
    func bind(to statement: OpaquePointer, at index: Int32) {
        sqlite3_bind_double(statement, index, self)
    }
}

extension Bool: SQLBindable {
    func bind(to statement: OpaquePointer, at index: Int32) {
        sqlite3_bind_int(statement, index, self ? 1 : 0)
    }
}

extension Date: SQLBindable {
    func bind(to statement: OpaquePointer, at index: Int32) {
        sqlite3_bind_double(statement, index, timeIntervalSince1970)
    }
}

extension Data: SQLBindable {
    func bind(to statement: OpaquePointer, at index: Int32) {
        _ = withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, index, buffer.baseAddress, Int32(buffer.count), SQLITE_TRANSIENT)
        }
    }
}

struct SQLRow {
    let statement: OpaquePointer

    func isNull(_ i: Int32) -> Bool { sqlite3_column_type(statement, i) == SQLITE_NULL }

    func string(_ i: Int32) -> String? {
        guard let text = sqlite3_column_text(statement, i) else { return nil }
        return String(cString: text)
    }

    func text(_ i: Int32) -> String { string(i) ?? "" }
    func int(_ i: Int32) -> Int { Int(sqlite3_column_int64(statement, i)) }
    func intOrNil(_ i: Int32) -> Int? { isNull(i) ? nil : int(i) }
    func double(_ i: Int32) -> Double { sqlite3_column_double(statement, i) }
    func bool(_ i: Int32) -> Bool { sqlite3_column_int(statement, i) != 0 }
    func date(_ i: Int32) -> Date? { isNull(i) ? nil : Date(timeIntervalSince1970: double(i)) }

    func data(_ i: Int32) -> Data? {
        guard let bytes = sqlite3_column_blob(statement, i) else { return nil }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, i)))
    }
}

enum SQLiteError: Error, CustomStringConvertible {
    case open(String)
    case prepare(String, String)
    case step(String)

    var description: String {
        switch self {
        case let .open(m): "open: \(m)"
        case let .prepare(sql, m): "prepare \(sql.prefix(80)): \(m)"
        case let .step(m): "step: \(m)"
        }
    }
}

/// A single SQLite connection guarded by its own serial queue. Calls are synchronous and
/// re-entrant, so a transaction block can call `run`/`query` freely.
final class SQLiteConnection: @unchecked Sendable {
    private var db: OpaquePointer?
    private let queue: DispatchQueue
    private let queueKey = DispatchSpecificKey<UInt8>()
    private var statements: [String: OpaquePointer] = [:]

    init(path: String, readOnly: Bool, label: String) throws {
        queue = DispatchQueue(label: "crate.sqlite.\(label)", qos: .userInitiated)
        queue.setSpecific(key: queueKey, value: 1)
        let flags = (readOnly ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)) | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            throw SQLiteError.open(message)
        }
        sqlite3_busy_timeout(db, 5000)
        if !readOnly {
            try exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        }
        try exec("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-16000;")
    }

    deinit {
        for statement in statements.values { sqlite3_finalize(statement) }
        sqlite3_close_v2(db)
    }

    private func onQueue<T>(_ block: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return try block() }
        return try queue.sync(execute: block)
    }

    private var errorMessage: String { db.map { String(cString: sqlite3_errmsg($0)) } ?? "closed" }

    func exec(_ sql: String) throws {
        try onQueue {
            guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
                throw SQLiteError.step(errorMessage + " in " + String(sql.prefix(120)))
            }
        }
    }

    private func prepared(_ sql: String) throws -> OpaquePointer {
        if let cached = statements[sql] {
            sqlite3_reset(cached)
            sqlite3_clear_bindings(cached)
            return cached
        }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLiteError.prepare(sql, errorMessage)
        }
        statements[sql] = statement
        return statement
    }

    private func bind(_ args: [SQLBindable?], to statement: OpaquePointer) {
        for (offset, value) in args.enumerated() {
            let index = Int32(offset + 1)
            if let value {
                value.bind(to: statement, at: index)
            } else {
                sqlite3_bind_null(statement, index)
            }
        }
    }

    func run(_ sql: String, _ args: [SQLBindable?] = []) throws {
        try onQueue {
            let statement = try prepared(sql)
            bind(args, to: statement)
            let rc = sqlite3_step(statement)
            sqlite3_reset(statement)
            guard rc == SQLITE_DONE || rc == SQLITE_ROW else { throw SQLiteError.step(errorMessage) }
        }
    }

    func query<T>(_ sql: String, _ args: [SQLBindable?] = [], map: (SQLRow) throws -> T) throws -> [T] {
        try onQueue {
            let statement = try prepared(sql)
            bind(args, to: statement)
            defer { sqlite3_reset(statement) }
            var results: [T] = []
            while true {
                let rc = sqlite3_step(statement)
                if rc == SQLITE_ROW {
                    results.append(try map(SQLRow(statement: statement)))
                } else if rc == SQLITE_DONE {
                    break
                } else {
                    throw SQLiteError.step(errorMessage)
                }
            }
            return results
        }
    }

    func scalarInt(_ sql: String, _ args: [SQLBindable?] = []) -> Int {
        (try? query(sql, args) { $0.int(0) }.first) ?? 0
    }

    func transaction(_ block: () throws -> Void) throws {
        try onQueue {
            try exec("BEGIN IMMEDIATE")
            do {
                try block()
                try exec("COMMIT")
            } catch {
                try? exec("ROLLBACK")
                throw error
            }
        }
    }
}
