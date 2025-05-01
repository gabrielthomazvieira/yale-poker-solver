#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Remote helper script to query the poker solver's SQLite database.

Accepts a database path and a base64 encoded JSON list of node paths,
retrieves the corresponding compressed data blobs from an SQLite database,
and returns them as a JSON object mapping paths to base64 encoded blobs.
Handles potential errors by returning a JSON object with an "error" key.
"""

import sys
import argparse
import sqlite3
import json
import base64
import os


def query_nodes(db_path, paths_to_query):
    """
     Connects to the SQLite DB and fetches data blobs for the requested paths.

     Args:
         db_path (str): Full path to the SQLite database file.
         paths_to_query (list): A list of path strings to query.

    Returns:
         dict: A dictionary containing the results in the format
               {"results": {"path1": "base64_blob1", ...}}
               or {"error": "Error message"} in case of failure.
    """
    valid_paths = [p for p in paths_to_query if isinstance(p, str)]
    results_dict = {}
    conn = None

    # Check if DB file exists before trying to connect
    if not os.path.exists(db_path):
        return {"error": f"Database file not found at: {db_path}"}

    try:
        # Connect to the database
        conn = sqlite3.connect(db_path, check_same_thread=False)
        cursor = conn.cursor()

        # If no valid paths were provided after filtering, return empty results
        if not valid_paths:
            return {"results": {}}

        # Dynamically create placeholders for the IN clause for batch fetching
        placeholders = ", ".join("?" * len(valid_paths))

        sql = f"""
            SELECT p.path_text, n.data
            FROM paths p
            JOIN nodes n ON p.path_id = n.path_id
            WHERE p.path_text IN ({placeholders});
            """

        cursor.execute(sql, valid_paths)

        # Fetch results and format them
        for row in cursor.fetchall():
            path_text, data_blob = row
            if data_blob is not None:
                # Encode the binary blob as base64 string for JSON transport
                results_dict[path_text] = base64.b64encode(data_blob).decode("ascii")
            else:
                # Handle null blobs defensively, though schema has NOT NULL
                results_dict[path_text] = None

        return {"results": results_dict}

    except sqlite3.Error as e:
        # Report specific SQLite errors
        return {"error": f"SQLite Error: {e} (DB: {db_path})"}
    except Exception as e:
        # Report other unexpected errors during query execution
        return {"error": f"An unexpected error occurred in query_nodes: {repr(e)}"}
    finally:
        # Ensure database connection is closed
        if conn:
            try:
                conn.close()
            except Exception:
                pass  # Ignore errors during close after another error may have occurred


def main():
    parser = argparse.ArgumentParser(
        description="Query solver SQLite DB. Reads paths from base64 JSON, returns base64 blobs."
    )
    parser.add_argument(
        "--db_path", required=True, help="Full path to the SQLite database file."
    )
    parser.add_argument(
        "--batch_json_base64",
        required=True,
        help="A base64 encoded JSON string representing a list of path texts to query.",
    )

    args = parser.parse_args()
    output_data = None
    paths_to_query = None

    try:
        decoded_json_string = base64.b64decode(args.batch_json_base64).decode("utf-8")
        paths_to_query = json.loads(decoded_json_string)

        if not isinstance(paths_to_query, list):
            raise ValueError("Decoded base64 data must be a JSON list.")
        if not all(isinstance(p, str) for p in paths_to_query):
            raise ValueError("All elements in the decoded JSON list must be strings.")

    except (base64.binascii.Error, UnicodeDecodeError) as b64e:
        output_data = {"error": f"Invalid Base64 encoding or UTF-8 decoding: {b64e}"}
    except json.JSONDecodeError as je:
        output_data = {"error": f"Invalid JSON format after base64 decoding: {je}"}
    except ValueError as ve:
        # Catches our validation errors
        output_data = {"error": str(ve)}
    except Exception as e:
        # Catch-all for other unexpected errors during argument processing
        output_data = {"error": f"Error processing arguments: {repr(e)}"}

    if output_data is None:
        if paths_to_query is not None:
            output_data = query_nodes(args.db_path, paths_to_query)
        else:
            output_data = {
                "error": "Internal script error: paths_to_query not set after parsing."
            }

    print(json.dumps(output_data, ensure_ascii=False))


if __name__ == "__main__":
    main()
