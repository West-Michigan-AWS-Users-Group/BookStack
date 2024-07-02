# WMAUG BookStack

This project contains the open source documentation application named BookStack.

It is deployed on ECS Fargate with an RDS database, with persistent files stored in an EFS volume.

- This is dependent on the VPC stack being deployed in the account in which it exists. This is configured and managed in the [wmaug-moderator-infrastructure](https://github.com/West-Michigan-AWS-Users-Group/wmaug-moderator-infrastructure) repo.
- The following SSM entries must also exist:
  - `/productionA/BookStack/DB_PASS`
  - `/all/awsAccountNumber`
  - `/all/aws/route53/wmaug.org/hostedZoneId`

## Deployment

```bash
AWS_DEFAULT_PROFILE=<profile-name> CDK_DEFAULT_PROFILE=<profile-name> npx cdk deploy
```
