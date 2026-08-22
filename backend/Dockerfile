FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY requirements-docker.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create a non-root user for security
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Do NOT bake secrets into the image – pass them at runtime via docker-compose env
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
