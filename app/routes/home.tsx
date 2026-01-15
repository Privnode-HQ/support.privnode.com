import type { Route } from "./+types/home";
import { Button, Card, CardBody, CardHeader } from "@heroui/react";
import { Link } from "react-router";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Privnode 支持" },
    { name: "description", content: "Privnode 支持" },
  ];
}

export default function Home() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Privnode 支持</h1>

      <Card>
        <CardHeader className="font-medium">联系我们</CardHeader>
        <CardBody className="space-y-3 text-default-600">
          <p>
            无法自助解答？发起工单，联系 Privnode 支持。我们将在平均 24 小时内回复您。
          </p>
          <div className="flex gap-3">
            <Button color="primary" as={Link} to="/new">
              发起工单
            </Button>
            <Button variant="flat" as={Link} to="/tickets">
              查看我的工单
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
