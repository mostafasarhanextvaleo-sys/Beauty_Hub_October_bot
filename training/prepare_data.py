"""Converts training-data/{conversations,synthetic_conversations}.jsonl into a
tokenized, loss-masked HF dataset ready for LoRA fine-tuning.

Each source line is {"messages": [system, user, model, ..., user, assistant],
"meta": {...}} — the last message is always the assistant's target JSON
completion; everything before it is context. Loss is masked to that final
completion only (standard SFT practice): the model shouldn't be supervised on
reproducing the system prompt or prior turns, only on producing the correct
structured reply given them.

Usage: training/venv/bin/python training/prepare_data.py
"""

import json
import os
import random

from transformers import AutoTokenizer
from datasets import Dataset

BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"
MAX_SEQ_LEN = 2048
VAL_FRACTION = 0.03
SEED = 42

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "training-data")
OUT_DIR = os.path.join(HERE, "tokenized_dataset")

SOURCE_FILES = ["synthetic_conversations.jsonl", "conversations.jsonl"]


def load_examples():
    examples = []
    for fname in SOURCE_FILES:
        path = os.path.join(DATA_DIR, fname)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                examples.append(json.loads(line))
    return examples


def tokenize_example(tokenizer, messages):
    # Full sequence: system + ... + final assistant completion.
    full_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    # Same messages minus the final assistant turn, with the generation
    # prompt appended — this is the exact prefix the full sequence should
    # start with, so its token length tells us how much of the front to mask.
    prompt_text = tokenizer.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True)

    full_ids = tokenizer(full_text, add_special_tokens=False)["input_ids"]
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]

    if len(full_ids) > MAX_SEQ_LEN:
        return None

    prompt_len = min(len(prompt_ids), len(full_ids))
    labels = [-100] * prompt_len + full_ids[prompt_len:]
    if len(labels) != len(full_ids):
        return None

    return {"input_ids": full_ids, "labels": labels, "attention_mask": [1] * len(full_ids)}


def main():
    print(f"Loading tokenizer for {BASE_MODEL} (downloads on first run)...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    raw_examples = load_examples()
    print(f"Loaded {len(raw_examples)} raw examples.")

    tokenized = []
    skipped_too_long = 0
    for ex in raw_examples:
        result = tokenize_example(tokenizer, ex["messages"])
        if result is None:
            skipped_too_long += 1
            continue
        tokenized.append(result)

    print(f"Tokenized {len(tokenized)} examples, skipped {skipped_too_long} (too long or masking mismatch).")

    random.Random(SEED).shuffle(tokenized)
    val_size = max(1, int(len(tokenized) * VAL_FRACTION))
    val_set = tokenized[:val_size]
    train_set = tokenized[val_size:]

    print(f"Train: {len(train_set)}  Val: {len(val_set)}")

    ds_train = Dataset.from_list(train_set)
    ds_val = Dataset.from_list(val_set)

    os.makedirs(OUT_DIR, exist_ok=True)
    ds_train.save_to_disk(os.path.join(OUT_DIR, "train"))
    ds_val.save_to_disk(os.path.join(OUT_DIR, "val"))
    print(f"Saved tokenized dataset to {OUT_DIR}")


if __name__ == "__main__":
    main()
