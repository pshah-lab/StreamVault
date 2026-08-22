import logging
import os
import re
import datetime
from decimal import Decimal
from typing import List

import boto3
from boto3.dynamodb.conditions import Key
from fastapi import FastAPI, Depends, HTTPException, Header, Path, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from jose import jwt as jose_jwt, ExpiredSignatureError, JWTError
from pydantic import BaseModel, field_validator
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="Pratham Cinema API")

# ── Security Headers Middleware ──

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Inject hardened security headers on every response."""

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https:; "
            "font-src 'self'; "
            "connect-src 'self' http://localhost:8000; "
            "frame-ancestors 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        return response

app.add_middleware(SecurityHeadersMiddleware)

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

MOVIE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")

class ProgressUpdate(BaseModel):
    movie_id: str
    seconds: float

    @field_validator("movie_id")
    @classmethod
    def validate_movie_id(cls, v: str) -> str:
        if not MOVIE_ID_PATTERN.match(v):
            raise ValueError("movie_id contains invalid characters")
        return v

class ProgressResponse(BaseModel):
    movie_id: str
    seconds: float
    updated_at: str

# ── Authentication Dependency ──

def get_current_user(
    authorization: str = Header(None)
) -> str:
    """Verify JWT and return user identifier. Rejects unauthenticated requests with 401."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    token = authorization.split(" ")[1]
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Empty token")

    secret = os.getenv("JWT_SECRET")
    if not secret:
        logger.error("JWT_SECRET environment variable is not configured")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="JWT secret not configured")

    try:
        claims = jose_jwt.decode(token, secret, algorithms=["HS256"])
    except ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except JWTError as e:
        logger.warning(f"JWT verification failed: {e}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user_id = claims.get("sub") or claims.get("email")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing user identity")
    return user_id

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
    movie_id: str = Path(..., pattern=r"^[a-zA-Z0-9_-]+$"),
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
