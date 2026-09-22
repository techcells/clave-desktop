# Linux Chromium (to render the staged pages with Linux fonts) and Tesseract 5 with both model sets.
FROM mcr.microsoft.com/playwright/python:v1.52.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-por \
      fonts-dejavu-core fonts-liberation fonts-ubuntu python3-pil curl && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages -q playwright==1.52.0
# The packaged models are tessdata_fast; tessdata_best is what passed the thresholds.
RUN mkdir -p /best \
 && curl -fsSL -o /best/eng.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata \
 && curl -fsSL -o /best/por.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/por.traineddata
