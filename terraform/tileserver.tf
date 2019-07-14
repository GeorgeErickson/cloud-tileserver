provider "aws" {
  version = "~> 2.16"
  profile = "default"
  region  = var.region
}

resource "aws_iam_role" "tileserver_role" {
  name = "tileserver_role"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
  tags = {
    tag-key = "tag-value"
  }
}

resource "aws_iam_role_policy_attachment" "exec-role" {
    role       = "${aws_iam_role.tileserver_role.name}"
    policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# resource "aws_iam_role_policy_attachment" "vpcAccess" {
#     role       = "${aws_iam_role.tileserver_role.name}"
#     policy_arn = "arn:aws:iam::aws:policy/AmazonVPCFullAccess"
# }

# resource "aws_iam_role_policy_attachment" "rdsAccess" {
#     role       = "${aws_iam_role.tileserver_role.name}"
#     policy_arn = "arn:aws:iam::aws:policy/AmazonRDSFullAccess"
# }


resource "aws_lambda_layer_version" "tileserver_layer" {
  filename = "../dist/tileserver_layer.zip"
  layer_name = "tileserver_layer"
  source_code_hash = "${filebase64sha256("../dist/tileserver_layer.zip")}"
  compatible_runtimes = ["nodejs10.x"]
}

resource "aws_lambda_function" "tileserver" {
  function_name = "tileserver"
  runtime = "nodejs10.x"
  filename = "./../dist/function.zip"
  role = "${aws_iam_role.tileserver_role.arn}"
  handler = "index.handler"
  source_code_hash = "${filebase64sha256("./../dist/function.zip")}"
  layers = ["${aws_lambda_layer_version.tileserver_layer.arn}"]
  vpc_config {
    subnet_ids = ["subnet-0fd5e742", "subnet-19dd2d73", "subnet-81d6f9fc"]
    security_group_ids = ["sg-61e63b00"]
  }
  environment {
    variables = {
      PGDATABASE = var.database_local
      PGHOST = var.postgres_host
      PGPASSWORD = var.postgres_password
      PGUSER = var.postgres_user
    }
  }
}
