// FR-022/FR-027: the identity of the embeddings the workers compute, shared by the worker that
// loads the model and by the store that keys a saved embeddings set on it.

/** The Hugging Face id of the embedding model. */
export const MODEL_ID = 'OPI-PIB/PolDense-17M';

/** The file name of the quantized model, which is the quantization a saved embeddings set is keyed on. */
export const MODEL_FILE_NAME = 'model_int4_with_embeddings';

/**
 * Names the state of everything the vectors depend on besides the provision texts, the model and the
 * quantization: the model file's content, the tokenizer, the query prefix, the pooling and the
 * transformers.js version. A saved set under another value is never used and is deleted.
 * Set it to the current UTC time when any of these change: `date --utc +%Y-%m-%dT%H:%M`.
 */
export const EMBEDDINGS_VERSION = '2026-10-10T14:18';
