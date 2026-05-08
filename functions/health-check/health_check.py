import json
import os
import subprocess
import sys
from typing import Any, NoReturn


def log_error(message: str) -> None:
    """Print an error message in GitHub Actions format."""
    print(f"::error::{message}", file=sys.stderr)


def fail(message: str) -> NoReturn:
    """Log error and exit with non-zero status."""
    log_error(message)
    sys.exit(1)


def run_appwrite_command(args: list[str], capture_json: bool = True) -> str:
    """
    Run an Appwrite CLI command.
    
    Args:
        args: List of command arguments.
        capture_json: Whether to append --json and return the stdout.
    """
    full_command = ["appwrite"] + args
    if capture_json:
        full_command.append("--json")
    
    try:
        # Use shell=False for security (default)
        result = subprocess.run(
            full_command,
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        # Appwrite CLI often outputs error details to stdout even with --json sometimes, 
        # but let's check both.
        error_msg = e.stderr.strip() or e.stdout.strip() or str(e)
        fail(f"Appwrite command failed: {error_msg}")


def check_dependencies() -> None:
    """Check if required external tools are available."""
    try:
        subprocess.run(["appwrite", "--version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        fail("Appwrite CLI not found. Please install it with 'npm install -g appwrite-cli'.")


def main() -> None:
    """Main execution logic for health check."""
    check_dependencies()

    # Configuration from environment
    endpoint = os.getenv("APPWRITE_ENDPOINT", "https://cloud.appwrite.io/v1")
    project_id = os.getenv("APPWRITE_PROJECT_ID")
    api_key = os.getenv("APPWRITE_API_KEY")
    function_id = os.getenv("FUNCTION_ID")

    if not all([project_id, api_key, function_id]):
        missing = [k for k, v in {
            "APPWRITE_PROJECT_ID": project_id,
            "APPWRITE_API_KEY": api_key,
            "FUNCTION_ID": function_id
        }.items() if not v]
        fail(f"Missing required environment variables: {', '.join(missing)}")

    print(f"Configuring Appwrite Client for project {project_id}...")
    # client command doesn't need to return JSON, just set the config
    run_appwrite_command([
        "client",
        "--endpoint", endpoint,
        "--project-id", project_id,
        "--key", api_key
    ], capture_json=False)

    print(f"Triggering health-check function ({function_id})...")
    execution_json = run_appwrite_command([
        "functions",
        "create-execution",
        "--function-id", function_id,
        "--async", "false"
    ])

    try:
        execution: dict[str, Any] = json.loads(execution_json)
    except json.JSONDecodeError as e:
        fail(f"Failed to parse execution JSON: {e}\nRaw output: {execution_json}")

    status = execution.get("status")
    print(f"Execution status: {status}")

    if status != "completed":
        # Log the full execution result for debugging if it failed
        print(f"Execution details: {json.dumps(execution, indent=2)}")
        fail(f"Function execution failed with status: {status}")

    response_body_raw = execution.get("responseBody", "{}")
    
    # The responseBody might be a string or already parsed JSON depending on CLI version/config
    # Usually it's a string that needs another JSON parse
    response_data: dict[str, Any] = {}
    if isinstance(response_body_raw, str):
        try:
            response_data = json.loads(response_body_raw)
        except json.JSONDecodeError:
            fail(f"Function returned non-JSON response body: {response_body_raw}")
    else:
        response_data = response_body_raw

    if response_data.get("ok") is True:
        print("✅ SUCCESS: Health check passed.")
        print(f"Response: {json.dumps(response_data, indent=2)}")
    else:
        print(f"Response: {json.dumps(response_data, indent=2)}")
        fail("Health check failed: 'ok' is not true in response.")


if __name__ == "__main__":
    main()
