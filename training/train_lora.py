"""LoRA fine-tune of Qwen2.5-1.5B-Instruct on the Beauty Hub October dataset,
CPU-only (this box's GPU is too old for bitsandbytes/QLoRA — see project
notes). No quantization: base model loaded in bfloat16 (halves memory vs
fp32) with LoRA adapters on top, gradient checkpointing to keep activation
memory down given ~4GB RAM headroom.

Usage:
  training/venv/bin/python training/train_lora.py [--max-steps N] [--epochs N]

  --max-steps N   stop after N optimizer steps regardless of epoch (useful
                  for a timed dry run to measure real per-step latency)
  --epochs N      number of passes over the training set (default 2)
"""

import argparse
import os
import time

import torch
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model
from datasets import load_from_disk

HERE = os.path.dirname(os.path.abspath(__file__))
# Local path, not the HF repo id — huggingface_hub's downloader stalled
# repeatedly on this network (both classic HTTP and Xet transfer), so the
# ~3GB model.safetensors was fetched manually via aria2's resumable
# multi-connection download into training/local_model/ instead.
BASE_MODEL = os.path.join(HERE, "local_model")
DATASET_DIR = os.path.join(HERE, "tokenized_dataset")
OUTPUT_DIR = os.path.join(HERE, "lora_out")

LORA_TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--max-steps", type=int, default=-1)
    p.add_argument("--epochs", type=float, default=2.0)
    p.add_argument("--max-seq-length", type=int, default=1024,
                    help="truncate tokenized examples to this many tokens to bound the lm_head logits tensor (vocab_size=151936 makes long sequences memory-heavy)")
    p.add_argument("--resume-from-checkpoint", type=str, default=None,
                    help="path to a lora_out/checkpoint-N dir to resume optimizer/scheduler/RNG state from")
    return p.parse_args()


class StepTimer:
    """Logs wall-clock time per training step so a short dry run can project
    a realistic ETA for the full run before committing hours of CPU time."""

    def __init__(self):
        self.last = time.time()
        self.count = 0

    def on_step(self, logs=None):
        now = time.time()
        elapsed = now - self.last
        self.last = now
        self.count += 1
        print(f"[step {self.count}] {elapsed:.1f}s/step")


def main():
    args = parse_args()

    print(f"Loading tokenizer/model for {BASE_MODEL}...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, dtype=torch.bfloat16, attn_implementation="sdpa")
    model.config.use_cache = False
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()

    lora_config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=LORA_TARGET_MODULES,
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    train_ds = load_from_disk(os.path.join(DATASET_DIR, "train"))
    val_ds = load_from_disk(os.path.join(DATASET_DIR, "val"))

    def truncate(example):
        # Keep the tail, not the head: loss is masked to the final assistant
        # completion (see prepare_data.py), which sits at the end of the
        # sequence, so a head-truncation would cut off the only supervised
        # tokens and leave an all -100 label row (nan loss).
        return {k: v[-args.max_seq_length :] if isinstance(v, list) else v for k, v in example.items()}

    train_ds = train_ds.map(truncate)
    val_ds = val_ds.map(truncate)
    print(f"Train examples: {len(train_ds)}  Val examples: {len(val_ds)}  (truncated to {args.max_seq_length} tokens)")

    collator = DataCollatorForSeq2Seq(tokenizer, model=model, padding=True, label_pad_token_id=-100)

    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        per_device_train_batch_size=1,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=8,
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        learning_rate=2e-4,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=5,
        eval_strategy="steps",
        eval_steps=50,
        save_strategy="steps",
        save_steps=50,
        save_total_limit=3,
        report_to=[],
        dataloader_num_workers=0,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        data_collator=collator,
    )

    print("Starting training...")
    trainer.train(resume_from_checkpoint=args.resume_from_checkpoint)

    final_dir = os.path.join(OUTPUT_DIR, "final")
    trainer.save_model(final_dir)
    tokenizer.save_pretrained(final_dir)
    print(f"Saved LoRA adapter to {final_dir}")


if __name__ == "__main__":
    main()
