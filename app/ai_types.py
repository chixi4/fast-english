from __future__ import annotations

from pydantic import BaseModel, Field


class GeneratedQuestion(BaseModel):
    id: str = Field(description="Unique question id, e.g. q1")
    type: str = Field(description="e.g. vocab_in_context|cloze|main_idea|detail|inference")
    stem: str
    choices: list[str] = Field(min_length=2, max_length=6)
    answer_index: int = Field(ge=0, le=5)
    explanation: str = ""
    target_term: str | None = None


class GeneratedSimulation(BaseModel):
    passage: str
    questions: list[GeneratedQuestion]

