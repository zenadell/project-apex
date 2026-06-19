import argparse
import sys
import pandas as pd

def main():
    parser = argparse.ArgumentParser(description="Analyze a CSV file with pandas.")
    parser.add_argument("csv_path", help="Path to the CSV file")
    args = parser.parse_args()

    try:
        df = pd.read_csv(args.csv_path)
    except FileNotFoundError:
        print(f"Error: File '{args.csv_path}' not found.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error reading CSV: {e}", file=sys.stderr)
        sys.exit(1)

    # Print row count
    print(f"Row count: {len(df)}")

    # Print column names
    cols = df.columns.tolist()
    print(f"Column names: {cols}")

    # For each numeric column, print its mean
    numeric_cols = df.select_dtypes(include="number").columns
    for col in numeric_cols:
        mean_val = df[col].mean()
        print(f"Mean of '{col}': {mean_val}")

if __name__ == "__main__":
    main()