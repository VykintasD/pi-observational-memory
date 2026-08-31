// om — durable observational-memory store for pi-observational-memory.
//
// Single-file SQLite (WAL) keyed by pi's immutable session id. Lives OUTSIDE any
// project repo (default: ~/.pi/agent/om/om.db) because the content is per-session,
// not per-project. Short-lived: one invocation per call, no daemon.
//
// Exit codes: 0 ok, 1 usage error (or: no search matches), 2 db error, 3 not found.
package main

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const schemaVersion = "1"

func die(code int, format string, args ...any) {
	fmt.Fprintf(os.Stderr, "om: "+format+"\n", args...)
	os.Exit(code)
}

func expand(p string) string {
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

// dbPath resolves --db <p> | --db=<p> (before the subcommand) > OM_DB env > default.
func dbPath(args []string) string {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--db" && i+1 < len(args) {
			return expand(args[i+1])
		}
		if strings.HasPrefix(a, "--db=") {
			return expand(strings.TrimPrefix(a, "--db="))
		}
		if strings.Contains(a, "=") {
			continue
		}
		if !strings.HasPrefix(a, "-") {
			break // reached the subcommand
		}
	}
	if p := os.Getenv("OM_DB"); p != "" {
		return expand(p)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		die(1, "cannot resolve home dir: %v", err)
	}
	return filepath.Join(home, ".pi", "agent", "om", "om.db")
}

// dsnEscapePath percent-encodes the characters that change DSN structure: '?' and '#' would
// otherwise delimit the query/fragment, and '%' would start an escape sequence. The DSN is
// parsed as a URI (first '?' starts the query), so without this a DB path containing '?' is
// silently truncated and data lands in the wrong file. SQLite's URI parser decodes the
// escapes back, so the real file path is preserved.
func dsnEscapePath(p string) string {
	var b strings.Builder
	b.Grow(len(p))
	for i := 0; i < len(p); i++ {
		switch c := p[i]; c {
		case '?', '#', '%':
			fmt.Fprintf(&b, "%%%02X", c)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func openDB(path string, readOnly bool) *sql.DB {
	var dsn string
	esc := dsnEscapePath(path)
	if readOnly {
		dsn = "file:" + esc + "?mode=ro&_pragma=busy_timeout(5000)"
	} else {
		dsn = "file:" + esc + "?_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		die(2, "open %s: %v", path, err)
	}
	if err := db.Ping(); err != nil {
		die(2, "open %s: %v", path, err)
	}
	if !readOnly {
		// Self-healing schema: any command can bootstrap the store.
		if _, err := db.Exec(`PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS journey (
				session_id TEXT PRIMARY KEY,
				body     TEXT NOT NULL,
				updated  TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS topics (
				session_id TEXT NOT NULL,
				slug       TEXT NOT NULL,
				title      TEXT NOT NULL,
				summary    TEXT NOT NULL DEFAULT '',
				updated    TEXT NOT NULL,
				body       TEXT NOT NULL,
				PRIMARY KEY (session_id, slug)
			);
			CREATE INDEX IF NOT EXISTS idx_topics_updated ON topics(updated);`); err != nil {
			die(2, "schema: %v", err)
		}
		if _, err := db.Exec(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)
			ON CONFLICT(key) DO NOTHING`, schemaVersion); err != nil {
			die(2, "schema meta: %v", err)
		}
	}
	return db
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func needArgs(n int, args []string, what string) {
	if len(args) < n {
		die(1, "%s: expected %d argument(s), got %d", what, n, len(args))
	}
}

func validSlug(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, "/\\\x00") {
		return false
	}
	return true
}

func readStdin() string {
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		die(1, "reading stdin: %v", err)
	}
	return string(b)
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
	}
	switch args[0] {
	case "init":
		cmdInit(args[1:])
	case "journey":
		cmdJourney(args[1:])
	case "topics":
		cmdTopics(args[1:])
	case "topic":
		cmdTopic(args[1:])
	case "fork-copy":
		cmdForkCopy(args[1:])
	case "import":
		cmdImport(args[1:])
	case "help", "-h", "--help":
		usage()
	default:
		die(1, "unknown command %q (see om help)", args[0])
	}
}

func usage() {
	fmt.Print(`om — durable observational-memory store (SQLite, keyed by session id)

usage: om [--db <path>] <command>

  init                              create/ensure the database
  journey get <session>             print journey body (empty when none)
  journey set <session>             set journey body from stdin
  topics list <session>             print [{slug,title,summary,updated}] JSON
  topic get <session> <slug>        print topic body
  topic put <session> <slug>        upsert topic; body from stdin;
                                    flags: --title --summary --updated
  topic del <session> <slug>        delete topic (idempotent)
  topic search <session> <pattern>  regex search; prints "slug<TAB>line" (exit 1 = no matches)
  fork-copy <src> <dst>             copy src session's journey+topics into dst (only if dst empty)
  import <session> <legacyDir>      import a legacy .memory/<sessionId>/ dir (topic *.md + JOURNEY.md)

DB path: --db flag > OM_DB env > ~/.pi/agent/om/om.db
`)
}

func cmdInit(args []string) {
	db := openDB(dbPath(os.Args[1:]), false)
	defer db.Close()
	fmt.Println("ok")
}

func cmdJourney(args []string) {
	if len(args) < 2 {
		die(1, "journey: expected <get|set> <session>")
	}
	verb, session := args[0], args[1]
	switch verb {
	case "get":
		db := openDB(dbPath(os.Args[1:]), true)
		defer db.Close()
		var body string
		err := db.QueryRow(`SELECT body FROM journey WHERE session_id = ?`, session).Scan(&body)
		if err == sql.ErrNoRows {
			return // no journey yet: empty output, exit 0
		}
		if err != nil {
			die(2, "journey get: %v", err)
		}
		fmt.Print(body)
	case "set":
		body := readStdin()
		db := openDB(dbPath(os.Args[1:]), false)
		defer db.Close()
		_, err := db.Exec(`INSERT INTO journey(session_id, body, updated) VALUES (?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET body = excluded.body, updated = excluded.updated`,
			session, body, now())
		if err != nil {
			die(2, "journey set: %v", err)
		}
		fmt.Println("ok")
	default:
		die(1, "journey: unknown verb %q", verb)
	}
}

type topicRow struct {
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Updated string `json:"updated"`
}

func cmdTopics(args []string) {
	if len(args) < 2 || args[0] != "list" {
		die(1, "topics: expected list <session>")
	}
	session := args[1]
	db := openDB(dbPath(os.Args[1:]), true)
	defer db.Close()
	rows, err := db.Query(`SELECT slug, title, summary, updated FROM topics
		WHERE session_id = ? ORDER BY slug`, session)
	if err != nil {
		die(2, "topics list: %v", err)
	}
	defer rows.Close()
	out := []topicRow{}
	for rows.Next() {
		var t topicRow
		if err := rows.Scan(&t.Slug, &t.Title, &t.Summary, &t.Updated); err != nil {
			die(2, "topics list: %v", err)
		}
		out = append(out, t)
	}
	b, err := json.Marshal(out)
	if err != nil {
		die(2, "topics list: %v", err)
	}
	fmt.Println(string(b))
}

func cmdTopic(args []string) {
	if len(args) == 0 {
		die(1, "topic: expected <get|put|del|search> ...")
	}
	verb := args[0]
	rest := args[1:]
	switch verb {
	case "get":
		needArgs(2, rest, "topic get")
		session, slug := rest[0], rest[1]
		db := openDB(dbPath(os.Args[1:]), true)
		defer db.Close()
		var body string
		err := db.QueryRow(`SELECT body FROM topics WHERE session_id = ? AND slug = ?`, session, slug).Scan(&body)
		if err == sql.ErrNoRows {
			die(3, "topic %q not found in session %s", slug, session)
		}
		if err != nil {
			die(2, "topic get: %v", err)
		}
		fmt.Print(body)
	case "put":
		// Flags may appear anywhere among the arguments.
		var title, summary, updated string
		var pos []string
		for i := 0; i < len(rest); i++ {
			a := rest[i]
			switch {
			case a == "--title" && i+1 < len(rest):
				i++
				title = rest[i]
			case strings.HasPrefix(a, "--title="):
				title = strings.TrimPrefix(a, "--title=")
			case a == "--summary" && i+1 < len(rest):
				i++
				summary = rest[i]
			case strings.HasPrefix(a, "--summary="):
				summary = strings.TrimPrefix(a, "--summary=")
			case a == "--updated" && i+1 < len(rest):
				i++
				updated = rest[i]
			case strings.HasPrefix(a, "--updated="):
				updated = strings.TrimPrefix(a, "--updated=")
			default:
				pos = append(pos, a)
			}
		}
		needArgs(2, pos, "topic put")
		session, slug := pos[0], pos[1]
		if !validSlug(slug) {
			die(1, "topic put: invalid slug %q", slug)
		}
		body := readStdin()
		if title == "" {
			title = slug
		}
		if updated == "" {
			updated = now()
		}
		db := openDB(dbPath(os.Args[1:]), false)
		defer db.Close()
		_, err := db.Exec(`INSERT INTO topics(session_id, slug, title, summary, updated, body)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id, slug) DO UPDATE SET
				title = excluded.title, summary = excluded.summary,
				updated = excluded.updated, body = excluded.body`,
			session, slug, title, summary, updated, body)
		if err != nil {
			die(2, "topic put: %v", err)
		}
		fmt.Println("ok")
	case "del":
		needArgs(2, rest, "topic del")
		session, slug := rest[0], rest[1]
		db := openDB(dbPath(os.Args[1:]), false)
		defer db.Close()
		_, err := db.Exec(`DELETE FROM topics WHERE session_id = ? AND slug = ?`, session, slug)
		if err != nil {
			die(2, "topic del: %v", err)
		}
		fmt.Println("ok")
	case "search":
		needArgs(2, rest, "topic search")
		session, pattern := rest[0], rest[1]
		re, err := regexp.Compile(pattern)
		if err != nil {
			die(1, "topic search: bad pattern: %v", err)
		}
		db := openDB(dbPath(os.Args[1:]), true)
		defer db.Close()
		rows, err := db.Query(`SELECT slug, title, summary, body FROM topics
			WHERE session_id = ? ORDER BY slug`, session)
		if err != nil {
			die(2, "topic search: %v", err)
		}
		defer rows.Close()
		matched := false
		count := 0
		emit := func(slug, line string) {
			matched = true
			fmt.Printf("%s\t%s\n", slug, line)
		}
		for rows.Next() && count < 200 {
			var slug, title, summary, body string
			if err := rows.Scan(&slug, &title, &summary, &body); err != nil {
				die(2, "topic search: %v", err)
			}
			if re.MatchString(title) && count < 200 {
				emit(slug, title)
				count++
			}
			if re.MatchString(summary) && count < 200 {
				emit(slug, summary)
				count++
			}
			sc := bufio.NewScanner(strings.NewReader(body))
			sc.Buffer(make([]byte, 1024*1024), 1024*1024)
			for sc.Scan() && count < 200 {
				if re.MatchString(sc.Text()) {
					emit(slug, sc.Text())
					count++
				}
			}
		}
		if !matched {
			os.Exit(1) // no matches, grep-style
		}
	default:
		die(1, "topic: unknown verb %q", verb)
	}
}

func cmdForkCopy(args []string) {
	needArgs(2, args, "fork-copy")
	src, dst := args[0], args[1]
	db := openDB(dbPath(os.Args[1:]), false)
	defer db.Close()

	// Idempotent copy-on-fork: seed only when dst has no memory rows at all.
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM topics WHERE session_id = ?`, dst).Scan(&n); err != nil {
		die(2, "fork-copy: %v", err)
	}
	if n == 0 {
		if err := db.QueryRow(`SELECT COUNT(*) FROM journey WHERE session_id = ?`, dst).Scan(&n); err != nil {
			die(2, "fork-copy: %v", err)
		}
	}
	if n > 0 {
		fmt.Println("skipped: dst session already has memory rows")
		return
	}

	tx, err := db.Begin()
	if err != nil {
		die(2, "fork-copy: %v", err)
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO topics(session_id, slug, title, summary, updated, body)
		SELECT ?, slug, title, summary, updated, body FROM topics WHERE session_id = ?`, dst, src)
	if err != nil {
		die(2, "fork-copy: %v", err)
	}
	topics, _ := res.RowsAffected()
	_, err = tx.Exec(`INSERT INTO journey(session_id, body, updated)
		SELECT ?, body, updated FROM journey WHERE session_id = ?`, dst, src)
	if err != nil {
		die(2, "fork-copy: %v", err)
	}
	if err := tx.Commit(); err != nil {
		die(2, "fork-copy: %v", err)
	}
	fmt.Printf("copied %d topic(s)\n", topics)
}

var fmRe = regexp.MustCompile(`^---\n([\s\S]*?)\n---\n?`)

// parseFrontMatter mirrors the legacy TS parser: flat `key: value` fields, quotes stripped.
func parseFrontMatter(content string) (front map[string]string, body string) {
	front = map[string]string{}
	m := fmRe.FindStringSubmatchIndex(content)
	if m == nil {
		return front, content
	}
	block := content[m[2]:m[3]]
	body = content[m[1]:]
	for _, line := range strings.Split(block, "\n") {
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') ||
			(value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		switch key {
		case "id", "title", "summary", "updated":
			front[key] = value
		}
	}
	return front, body
}

func cmdImport(args []string) {
	needArgs(2, args, "import")
	session, legacyDir := args[0], expand(args[1])
	entries, err := os.ReadDir(legacyDir)
	if err != nil {
		die(1, "import: cannot read %s: %v", legacyDir, err)
	}
	db := openDB(dbPath(os.Args[1:]), false)
	defer db.Close()

	topics := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		name := e.Name()
		if name == "INDEX.md" || name == "JOURNEY.md" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(legacyDir, name))
		if err != nil {
			die(1, "import: reading %s: %v", name, err)
		}
		front, body := parseFrontMatter(string(b))
		slug := front["id"]
		if slug == "" {
			slug = strings.TrimSuffix(name, ".md")
		}
		if !validSlug(slug) {
			fmt.Fprintf(os.Stderr, "om: import: skipping %s (bad slug %q)\n", name, slug)
			continue
		}
		title := front["title"]
		if title == "" {
			title = slug
		}
		updated := front["updated"]
		if updated == "" {
			updated = now()
		}
		if _, err := db.Exec(`INSERT INTO topics(session_id, slug, title, summary, updated, body)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id, slug) DO UPDATE SET
				title = excluded.title, summary = excluded.summary,
				updated = excluded.updated, body = excluded.body`,
			session, slug, title, front["summary"], updated, body); err != nil {
			die(2, "import: %v", err)
		}
		topics++
	}

	journey := false
	if b, err := os.ReadFile(filepath.Join(legacyDir, "JOURNEY.md")); err == nil {
		body := strings.TrimSpace(string(b))
		if body != "" {
			if _, err := db.Exec(`INSERT INTO journey(session_id, body, updated) VALUES (?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET body = excluded.body, updated = excluded.updated`,
				session, string(b), now()); err != nil {
				die(2, "import: journey: %v", err)
			}
			journey = true
		}
	}
	fmt.Printf("imported %d topic(s), journey=%v\n", topics, journey)
}
