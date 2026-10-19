# Кто принимает результат и какие эффекты проходят (deploy/contour-stand/README.md).
# Вход: пакет процесса, результат с проверками, предложенные агентом эффекты
# и случайное число для выборки на аудит. Границы ИБ — data.base (base.json).
package contour.accept

import rego.v1

decision := {
	"result": result,
	"reasons": [r | some r in reasons],
	"effects": [decide(e) | some e in input.effects],
}

default result := "human"

result := "auto" if {
	input.process.autonomy >= 2
	count(input.result.checks.failed) == 0
	reviewer_ok
	not audited
	not signing
}

# A document going to signature is accepted by a person: the signature
# binds the exact version a person accepted.
signing if {
	some e in input.effects
	decide(e).decision == "sign"
}

reasons contains "документ пойдёт на подпись: версию принимает человек" if signing

reasons contains sprintf("проверка не пройдена: %s", [f]) if some f in input.result.checks.failed

reasons contains sprintf("ступень %d: результат принимает человек", [input.process.autonomy]) if input.process.autonomy < 2

reasons contains "выборка на аудит" if {
	input.process.autonomy >= 2
	audited
}

reasons contains "проверяющий на той же модели, что исполнитель: его вердикт не в счёт" if {
	input.process.reviewer_required
	input.result.reviewer.vendor == input.result.executor.vendor
}

reasons contains "нет вердикта проверяющего" if {
	input.process.reviewer_required
	not input.result.reviewer.verdict
}

# A reviewer counts only if it is a different vendor's model than the
# executor: the same model tends to miss the same mistakes.
reviewer_ok if not input.process.reviewer_required

reviewer_ok if {
	input.result.reviewer.verdict == "ok"
	input.result.reviewer.vendor != input.result.executor.vendor
}

audited if input.sample < object.get(data.base.audit_sample, sprintf("%d", [input.process.autonomy]), 0)

# ---- effects: deny / sign / auto / human, with the reason
decide(e) := {"type": e.type, "decision": "deny", "why": "эффекта нет в границах ИБ"} if {
	not data.base.effects[e.type]
} else := {"type": e.type, "decision": "deny", "why": "эффекта нет в пакете процесса"} if {
	not input.process.effects[e.type]
} else := {"type": e.type, "decision": "deny", "why": "отдел не может писать наружу"} if {
	e.type == "mail.send"
	not input.process.department in data.base.effects["mail.send"].departments
} else := {"type": e.type, "decision": "deny", "why": "сумма выше границы ИБ"} if {
	e.amount > data.base.effects[e.type].max_amount
} else := {"type": e.type, "decision": "deny", "why": "больше подзадач, чем разрешено"} if {
	e.type == "swarm.spawn"
	count(e.children) > data.base.effects["swarm.spawn"].max_children
} else := {"type": e.type, "decision": "sign", "why": "юридически значимое действие: подписывает человек"} if {
	e.type == "edo.queue"
} else := {"type": e.type, "decision": "auto", "why": "в пределах ступени и лимита пакета"} if {
	spec := input.process.effects[e.type]
	input.process.autonomy >= spec.auto_from
	within_limit(e, spec)
} else := {"type": e.type, "decision": "human", "why": "выше ступени или лимита: подтверждает человек"}

within_limit(e, spec) if not spec.limit

within_limit(e, spec) if e.amount <= spec.limit
