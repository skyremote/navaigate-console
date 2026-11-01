# Build from the kit folder:  docker compose build   (context is the kit root)
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY connector connector
COPY scripts scripts
COPY schema schema
ENV PYTHONUNBUFFERED=1 BRAIN_HOME=/state
CMD ["python", "connector/brain_mcp.py"]
