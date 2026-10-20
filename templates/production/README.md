# Local production skeleton

These tracked files document the defaults created by the internal production bootstrap. Runtime copies live under ignored `projects/` and `artifacts/` directories and must be backed up outside Git. Each `projects/<client_id>/` directory contains the client manifest and shared brand material alongside its `VNNN/` video projects.

For a standard project, the bootstrap creates `brief/`, `assets/`, `requests/`, `reviews/`, `edits/`, and `variants.json` beside `project.json`. A legacy alias keeps `project.json` in the client registry while `storage.project_root` points to an existing recognized project inside the workspace. It never moves or edits the legacy project.

Placeholders in the JSON templates are descriptive. Runtime manifests contain validated IDs, paths, and UTC timestamps.
