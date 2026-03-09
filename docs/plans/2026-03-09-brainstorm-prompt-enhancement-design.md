# Design: Brainstorm Prompt Enhancement

## Overview
현재의 `/swarm:brainstorm` 명령어가 사용자가 미처 생각하지 못한 '모르는 부분(Unknowns)'을 최대한 끌어내고, `/swarm:plan` 명령어에서 곧바로 사용할 수 있는 원자적 형태(Atomic Level)의 이해도에 도달하도록 내부 프롬프트를 개선합니다.

## Chosen Approach
**Hybrid Approach: Atomic Deep Dive + Devil's Advocate**
1. **원자적 분할 (Atomic Deep Dive):** 에이전트가 먼저 사용자의 큰 목표를 가장 작은 단위의 기능(Functional Requirement)으로 쪼개도록 유도합니다.
2. **예외 집중 추적 (Devil's Advocate):** 도출된 각 원자적 기능마다 "만약 [예외 상황/실패/의존성 단절]이 발생하면 어떻게 되나요?"라는 반증적 질문을 최소 1개 이상 던져 사용자가 엣지 케이스를 강제로 고민하게 만듭니다.
3. **문서화 구조:** 발굴된 엣지 케이스와 예외 처리 방안을 독립된 섹션이 아닌, 각 기능(FR)의 하위 항목으로 병합하여 기록합니다.

## Trade-offs Considered
- **Pros (장점):** 요구사항이 진정한 최소 단위로 쪼개져 계획(Plan) 단계의 정확도가 매우 높아집니다. 기획 초기 단계에서 예외 상황을 강제로 고민하게 만들어 실행 단계의 병목과 버그를 대폭 줄일 수 있습니다.
- **Cons (단점):** 프로젝트 규모가 클 경우, 모든 기능마다 예외 상황을 묻고 답하는 과정이 다소 길고 번거로울 수 있습니다. (하지만 이는 실행 단계에서의 시간을 크게 절약해 주므로 감수할 만한 트레이드오프입니다.)

## High-Level Architecture/Components
- **프롬프트 구조 변경 (`commands/swarm/brainstorm.toml`):**
  - **Phase 1 (기능 쪼개기):** 사용자의 목표를 듣고 가장 핵심이 되는 첫 번째 최소 단위 동작이 무엇인지 질문하는 지침 추가.
  - **Phase 2 (예외 질문하기):** 기능이 정의될 때마다, 해당 기능이 실패하거나 제약 조건에 부딪히는 구체적 상황을 가정하여 어떻게 대응할지 질문하는 지침 추가.
  - **출력 포맷 (Output Formatting):** 최종 Design Document 산출 시, 기능 요건(FR) 목록 아래에 서브 불릿(Sub-bullet)으로 예외 처리 로직(Exception handling)을 반드시 명시하도록 강제.