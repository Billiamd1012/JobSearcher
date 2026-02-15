# Applicant details (for cover letter generator)

The cover letter generator can use your name and other details when generating letters. Put your details in the **applicant-details** folder (inside `details/`) so they are used automatically. The contents of that folder are gitignored so your personal data is not committed.

## Folder location

Create this folder if it does not exist:

- **`document-creation/documents/details/applicant-details/`**

Everything inside this folder is ignored by git. Only this template file is tracked.

## File format

Place a JSON file in the folder. The generator looks for:

1. **`applicant.json`** (preferred), or  
2. The first `.json` file in the folder (alphabetically).

### JSON fields

| Field            | Required | Description |
|------------------|----------|-------------|
| `applicantName`  | Yes      | Full name used in the prompt and sign-off (e.g. `"Jane Doe"`). |
| `lastName`       | No       | Last name used in output folder names (e.g. `YYMMDD.LastName.CL.Company`). If omitted, derived from `applicantName`. |
| `dob`            | No       | Date of birth (e.g. `"1990-01-15"`). For future use in prompts if needed. |
| *(any other)*    | No       | Additional fields are read and may be used later. |

### Example: `applicant.json`

```json
{
  "applicantName": "Jane Doe",
  "lastName": "Doe",
  "dob": "1990-01-15"
}
```

Minimal example (name only):

```json
{
  "applicantName": "Jane Doe"
}
```

## How the generator uses it

- **Applicant name:** Inserted into the cover letter prompt as applicant context and used in the sign-off (e.g. “Yours sincerely, [Your full name]”).
- **Last name:** Used in the output folder name for each job, e.g. `260215.Doe.CL.CompanyName`.
- **DOB:** Loaded for possible future use (e.g. optional inclusion in prompts).

If no file is found in `applicant-details/`, the generator falls back to the `APPLICANT_NAME` and `APPLICANT_LAST_NAME` environment variables, or defaults to “Applicant” for the folder name.

## Steps

1. Create the folder: `document-creation/documents/details/applicant-details/`
2. Create a file named `applicant.json` (or any `.json` name) in that folder.
3. Add your details in the JSON format above.
4. Run the cover letter generator as usual; it will load this file automatically.
