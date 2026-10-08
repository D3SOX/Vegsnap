package app.vegsnap

/** Stages are emitted by the work itself; they do not imply a percentage or remaining duration. */
enum class CheckStage(val label: Int) {
    PREPARING(R.string.progress_preparing),
    DATABASE(R.string.progress_database),
    ANALYZING_PHOTO(R.string.progress_photo),
    ANALYZING_TEXT(R.string.progress_text),
    SEARCHING_WEB(R.string.progress_web),
    EVALUATING(R.string.progress_evaluating),
    OCR_FALLBACK(R.string.progress_ocr),
    SAVING(R.string.progress_saving),
}
