# Cover Letter Generator — Pseudo Code

**Goal:** Generate personalised cover letters by spinning up a local LLM.

---

## 1. SETUP / ENTRY POINT

- Accept inputs: path to job-data JSON file(s), optional path to resume, output path (e.g. `document-creation/documents/coverletter/`).
- Resolve paths; ensure output directory exists.
- Load job data (position name, company, description, link, etc.).
- Optionally load resume text or path for context.

---

## 2. LOCAL LLM LIFECYCLE

- Determine which local LLM to use (e.g. Ollama, LM Studio, llama.cpp server, or env-configured executable).
- Check if the LLM service/process is already running (e.g. Ollama on default port, or configurable URL).
- If not running:
  - Spawn the local LLM process (e.g. start Ollama serve, or launch a local server binary).
  - Wait until the service reports ready (health check / readiness endpoint or timeout).
- If already running: skip spawn, proceed to generation.
- On exit (success or failure): optionally leave the LLM running for reuse, or tear down the process we started (configurable).

---

## 3. PROMPT CONSTRUCTION

- Load or build a cover-letter prompt template (e.g. from `document-creation/prompts/` or inline).
- Template placeholders: company name, role title, job description (full or summarised), applicant name/context, resume snippet.
- Optionally truncate or summarise the job description to fit context window.
- Build the final prompt string (system + user, or single user message, depending on LLM API).

---

## 4. CALL LOCAL LLM

- Send the prompt to the local LLM (HTTP to localhost, or stdio to process, depending on integration).
- Set generation parameters: max tokens, temperature, stop sequences (e.g. "Yours sincerely" or double newline).
- Handle streaming or non-streaming response; collect full text.
- Handle errors: timeout, connection refused, invalid response; retry or fail with clear message.

---

## 5. POST-PROCESS AND SAVE

- Strip any extra markdown or boilerplate from the model output if needed.
- Ensure the cover letter is plain text
- Generate output filename YYMMDD.LastName.CL.CompanyName (nowhitespace).docx
- Write the cover letter to the output folder (e.g. `document-creation/documents/coverletter/<filename>.docx`).
- Log success and path; return path or summary for caller.

---

## 6. CLEANUP (if we started the LLM)

- If we spawned the LLM in step 2, optionally kill the process or leave it running per config.
- Close any connections or resources.

---

## 7. EDGE CASES / LATER

- Multiple jobs: loop over job-data files or array of jobs; one cover letter per job.
- Model selection: allow env or config to choose model name (e.g. Ollama model id).
- Resume path: optional; if provided, inject resume summary or key points into the prompt.
- Rate limiting / backoff if the local LLM is slow or overloaded.
