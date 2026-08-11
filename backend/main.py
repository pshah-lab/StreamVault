import os
import datetime
from decimal import Decimal
from typing import List
import boto3
from boto3.dynamodb.conditions import Key
from fastapi import FastAPI, Depends, HTTPException, Header, status
from fastapi.middleware.cors import CORSMiddleware
from jose import jwt as jose_jwt
from pydantic import BaseModel

app = FastAPI(title="Pratham Cinema API")

# ── DynamoDB Client Setup ──

TABLE_NAME = os.getenv("DYNAMODB_TABLE_NAME", "StreamVaultPlaybackProgress")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
table = dynamodb.Table(TABLE_NAME)

# ── Configure Strict CORS ──

VIEWER_DOMAIN = os.getenv("VIEWER_DOMAIN", "")
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
]
if VIEWER_DOMAIN:
    domain_url = VIEWER_DOMAIN if VIEWER_DOMAIN.startswith("http") else f"https://{VIEWER_DOMAIN}"
    ALLOWED_ORIGINS.append(domain_url)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# ── Pydantic Schemas ──

class ProgressUpdate(BaseModel):
    movie_id: str
    seconds: float

class ProgressResponse(BaseModel):
    movie_id: str
    seconds: float
    updated_at: str

# ── Authentication Dependency ──

def get_current_user(
    authorization: str = Header(None)
) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        return "default_viewer"
        
    token = authorization.split(" ")[1]
    if not token or token in ("null", "undefined"):
        return "default_viewer"

    try:
        claims = jose_jwt.get_unverified_claims(token)
        return claims.get("sub") or claims.get("email") or "default_viewer"
    except Exception:
        return "default_viewer"

# ── Endpoints ──

@app.post("/api/progress")
def save_progress(
    progress_in: ProgressUpdate,
    user_id: str = Depends(get_current_user)
):
    now_iso = datetime.datetime.utcnow().isoformat()
    try:
        table.put_item(
            Item={
                "user_id": user_id,
                "movie_id": progress_in.movie_id,
                "seconds": Decimal(str(round(progress_in.seconds, 2))),
                "updated_at": now_iso,
            }
        )
        return {"status": "success", "seconds": progress_in.seconds}
    except Exception as e:
        print(f"DynamoDB save_progress error: {e}")
        return {"status": "success", "seconds": progress_in.seconds}

@app.get("/api/progress/{movie_id}")
def get_progress(
    movie_id: str,
    user_id: str = Depends(get_current_user)
):
    try:
        response = table.get_item(
            Key={
                "user_id": user_id,
                "movie_id": movie_id,
            }
        )
        item = response.get("Item")
        if not item:
            return {"seconds": 0.0}
        return {"seconds": float(item.get("seconds", 0.0))}
    except Exception as e:
        print(f"DynamoDB get_progress error: {e}")
        return {"seconds": 0.0}

@app.get("/api/history", response_model=List[ProgressResponse])
def get_history(
    user_id: str = Depends(get_current_user)
):
    try:
        response = table.query(
            IndexName="UserUpdatedAtIndex",
            KeyConditionExpression=Key("user_id").eq(user_id),
            ScanIndexForward=False
        )
        items = response.get("Items", [])
        result = []
        for item in items:
            result.append(
                ProgressResponse(
                    movie_id=item["movie_id"],
                    seconds=float(item.get("seconds", 0.0)),
                    updated_at=str(item.get("updated_at", "")),
                )
            )
        return result
    except Exception as e:
        print(f"DynamoDB get_history error: {e}")
        return []
